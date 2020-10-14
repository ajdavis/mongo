/**
 *    Copyright (C) 2018-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#define MONGO_LOGV2_DEFAULT_COMPONENT ::mongo::logv2::LogComponent::kCommand

#include "mongo/platform/basic.h"

#include "mongo/db/commands/feature_compatibility_version.h"

#include <fmt/format.h>

#include "mongo/base/status.h"
#include "mongo/db/catalog_raii.h"
#include "mongo/db/commands/feature_compatibility_version_document_gen.h"
#include "mongo/db/commands/feature_compatibility_version_documentation.h"
#include "mongo/db/commands/feature_compatibility_version_gen.h"
#include "mongo/db/commands/feature_compatibility_version_parser.h"
#include "mongo/db/dbdirectclient.h"
#include "mongo/db/namespace_string.h"
#include "mongo/db/operation_context.h"
#include "mongo/db/repl/optime.h"
#include "mongo/db/repl/replication_coordinator.h"
#include "mongo/db/repl/replication_process.h"
#include "mongo/db/repl/storage_interface.h"
#include "mongo/db/s/collection_sharding_state.h"
#include "mongo/db/s/sharding_state.h"
#include "mongo/db/service_context.h"
#include "mongo/db/storage/storage_engine.h"
#include "mongo/db/wire_version.h"
#include "mongo/db/write_concern_options.h"
#include "mongo/logv2/log.h"
#include "mongo/rpc/get_status_from_command_result.h"
#include "mongo/transport/service_entry_point.h"

namespace mongo {

using repl::UnreplicatedWritesBlock;
using FCVP = FeatureCompatibilityVersionParser;
using FCVParams = ServerGlobalParams::FeatureCompatibility;
using FCVVersion = FCVParams::Version;

using namespace fmt::literals;

Lock::ResourceMutex FeatureCompatibilityVersion::fcvLock("featureCompatibilityVersionLock");

namespace {
struct FCVState {
    FCVVersion effectiveVersion;
    FCVVersion currentVersion;
    boost::optional<FCVParams::Version> targetVersion;
    boost::optional<FCVParams::Version> previousVersion;
    bool isOnlyPermittedForConfigServer;
};

// TODO: neaten with macros, explain
// TODO: explain, especially regarding when lastContinuous == lastLTS
// While upgrading or downgrading, we use the older of the two FCVs.
// TODO: rename "transition" variables to "fcvState"
using FCVTransitions = stdx::unordered_map<std::pair<FCVVersion, FCVVersion>, FCVState>;
const FCVTransitions transitions({
    // Non-transitions. TODO: needed?
    {{FCVParams::kLastLTS, FCVParams::kLastLTS}, {FCVParams::kLastLTS, FCVParams::kLastLTS}},

    {{FCVParams::kLastContinuous, FCVParams::kLastContinuous},
     {FCVParams::kLastContinuous, FCVParams::kLastContinuous}},

    {{FCVParams::kLatest, FCVParams::kLatest}, {FCVParams::kLatest, FCVParams::kLatest}},

    // Start upgrade from last-lts to latest:
    {{FCVParams::kLastLTS, FCVParams::kLatest},
     {FCVParams::kLastLTS, FCVParams::kUpgradingFromLastLTSToLatest, FCVParams::kLatest}},

    // Resume upgrade from last-lts to latest:
    {{FCVParams::kUpgradingFromLastLTSToLatest, FCVParams::kLatest},
     {FCVParams::kLastLTS, FCVParams::kUpgradingFromLastLTSToLatest}},

    // Start upgrade from last-continuous to latest:
    {{FCVParams::kLastContinuous, FCVParams::kLatest},
     {FCVParams::kLastContinuous,
      FCVParams::kUpgradingFromLastContinuousToLatest,
      FCVParams::kLatest}},

    // Resume upgrade from last-continuous to latest:
    {{FCVParams::kUpgradingFromLastContinuousToLatest, FCVParams::kLatest},
     {FCVParams::kLastContinuous, FCVParams::kUpgradingFromLastContinuousToLatest}},

    // Start downgrade from latest to last-lts:
    {{FCVParams::kLatest, FCVParams::kLastLTS},
     {FCVParams::kLastLTS,
      FCVParams::kDowngradingFromLatestToLastLTS,
      FCVParams::kLastLTS,
      FCVParams::kLatest}},

    // Resume downgrade from latest to last-lts:
    {{FCVParams::kDowngradingFromLatestToLastLTS, FCVParams::kLastLTS},
     {FCVParams::kLastLTS,
      FCVParams::kDowngradingFromLatestToLastLTS,
      FCVParams::kLastLTS,
      FCVParams::kLatest}},

    // Start downgrade from latest to last-continuous:
    {{FCVParams::kLatest, FCVParams::kLastContinuous},
     {FCVParams::kLastContinuous,
      FCVParams::kDowngradingFromLatestToLastContinuous,
      FCVParams::kLastContinuous,
      FCVParams::kLatest}},

    // Resume downgrade from latest to last-continuous:
    {{FCVParams::kDowngradingFromLatestToLastContinuous, FCVParams::kLastContinuous},
     {FCVParams::kLastContinuous,
      FCVParams::kDowngradingFromLatestToLastContinuous,
      FCVParams::kLastContinuous,
      FCVParams::kLatest}},

    // Start upgrade from last-lts to last-continuous (only config server may request this
    // transition):
    {{FCVParams::kLastLTS, FCVParams::kLastContinuous},
     {FCVParams::kLastLTS,
      FCVParams::kUpgradingFromLastLTSToLastContinuous,
      FCVParams::kLastContinuous,
      boost::none,
      true}},

    // Resume upgrade from last-lts to last-continuous (only config server may request this
    // transition):
    {{FCVParams::kUpgradingFromLastLTSToLastContinuous, FCVParams::kLastContinuous},
     {FCVParams::kLastLTS,
      FCVParams::kUpgradingFromLastLTSToLastContinuous,
      boost::none,
      boost::none,
      true}},
});

void setFCVDocumentFields(FeatureCompatibilityVersionDocument& doc,
                          const FCVTransitions::value_type& value) {
    const auto& fcvState = value.second;
    doc.setVersion(fcvState.effectiveVersion);
    doc.setTargetVersion(fcvState.targetVersion);
    doc.setPreviousVersion(fcvState.previousVersion);
}

void setFCVDocumentFields(FeatureCompatibilityVersionDocument& doc,
                          FCVVersion fromVersion,
                          FCVVersion newVersion) {
    auto it = transitions.find({fromVersion, newVersion});
    fassert(0, it != transitions.end());
    setFCVDocumentFields(doc, *it);
}

bool isWriteableStorageEngine() {
    return !storageGlobalParams.readOnly && (storageGlobalParams.engine != "devnull");
}

// Returns the featureCompatibilityVersion document if it exists.
boost::optional<BSONObj> findFcvDocument(OperationContext* opCtx) {
    // Ensure database is opened and exists.
    AutoGetOrCreateDb autoDb(opCtx, NamespaceString::kServerConfigurationNamespace.db(), MODE_IX);

    const auto query = BSON("_id" << FeatureCompatibilityVersionParser::kParameterName);
    const auto swFcv = repl::StorageInterface::get(opCtx)->findById(
        opCtx, NamespaceString::kServerConfigurationNamespace, query["_id"]);
    if (!swFcv.isOK()) {
        return boost::none;
    }
    return swFcv.getValue();
}

/**
 * Build update command for featureCompatibilityVersion document updates.
 */
void runUpdateCommand(OperationContext* opCtx, const FeatureCompatibilityVersionDocument& fcvDoc) {
    DBDirectClient client(opCtx);
    NamespaceString nss(NamespaceString::kServerConfigurationNamespace);

    BSONObjBuilder updateCmd;
    updateCmd.append("update", nss.coll());
    {
        BSONArrayBuilder updates(updateCmd.subarrayStart("updates"));
        {
            BSONObjBuilder updateSpec(updates.subobjStart());
            {
                BSONObjBuilder queryFilter(updateSpec.subobjStart("q"));
                queryFilter.append("_id", FeatureCompatibilityVersionParser::kParameterName);
            }
            {
                BSONObjBuilder updateMods(updateSpec.subobjStart("u"));
                fcvDoc.serialize(&updateMods);
            }
            updateSpec.appendBool("upsert", true);
        }
    }
    auto timeout = opCtx->getWriteConcern().usedDefault ? WriteConcernOptions::kNoTimeout
                                                        : opCtx->getWriteConcern().wTimeout;
    auto newWC = WriteConcernOptions(
        WriteConcernOptions::kMajority, WriteConcernOptions::SyncMode::UNSET, timeout);
    updateCmd.append(WriteConcernOptions::kWriteConcernField, newWC.toBSON());

    // Update the featureCompatibilityVersion document stored in the server configuration
    // collection.
    BSONObj updateResult;
    client.runCommand(nss.db().toString(), updateCmd.obj(), updateResult);
    uassertStatusOK(getStatusFromWriteCommandReply(updateResult));
}
}  // namespace

Status FeatureCompatibilityVersion::validateSetFeatureCompatibilityVersionRequest(
    FCVVersion fromVersion, FCVVersion newVersion, bool isFromConfigServer) {

    auto it = transitions.find({fromVersion, newVersion});
    if (it == transitions.end() ||
        (it->second.isOnlyPermittedForConfigServer && !isFromConfigServer)) {
        return Status(
            ErrorCodes::IllegalOperation,
            "cannot set featureCompatibilityVersion to '{}' while featureCompatibilityVersion is '{}'"_format(
                FCVP::toString(newVersion), FCVP::toString(fromVersion)));
    }

    return Status::OK();
}

void FeatureCompatibilityVersion::setTarget(OperationContext* opCtx,
                                            FCVParams::Version fromVersion,
                                            FCVParams::Version newVersion) {
    FeatureCompatibilityVersionDocument fcvDoc;
    setFCVDocumentFields(fcvDoc, fromVersion, newVersion);
    runUpdateCommand(opCtx, fcvDoc);
}

void FeatureCompatibilityVersion::setIfCleanStartup(OperationContext* opCtx,
                                                    repl::StorageInterface* storageInterface) {
    if (!isCleanStartUp())
        return;

    // If the server was not started with --shardsvr, the default featureCompatibilityVersion on
    // clean startup is the upgrade version. If it was started with --shardsvr, the default
    // featureCompatibilityVersion is the downgrade version, so that it can be safely added to a
    // downgrade version cluster. The config server will run setFeatureCompatibilityVersion as part
    // of addShard.
    const bool storeUpgradeVersion = serverGlobalParams.clusterRole != ClusterRole::ShardServer;

    UnreplicatedWritesBlock unreplicatedWritesBlock(opCtx);
    NamespaceString nss(NamespaceString::kServerConfigurationNamespace);

    {
        CollectionOptions options;
        options.uuid = CollectionUUID::gen();
        uassertStatusOK(storageInterface->createCollection(opCtx, nss, options));
    }

    FeatureCompatibilityVersionDocument fcvDoc;
    if (storeUpgradeVersion) {
        fcvDoc.setVersion(FCVParams::kLatest);
    } else {
        fcvDoc.setVersion(FCVParams::kLastLTS);
    }

    // We then insert the featureCompatibilityVersion document into the server configuration
    // collection. The server parameter will be updated on commit by the op observer.
    uassertStatusOK(storageInterface->insertDocument(
        opCtx,
        nss,
        repl::TimestampedBSONObj{fcvDoc.toBSON(), Timestamp()},
        repl::OpTime::kUninitializedTerm));  // No timestamp or term because this write is not
                                             // replicated.
}

bool FeatureCompatibilityVersion::isCleanStartUp() {
    StorageEngine* storageEngine = getGlobalServiceContext()->getStorageEngine();
    std::vector<std::string> dbNames = storageEngine->listDatabases();

    for (auto&& dbName : dbNames) {
        if (dbName != "local") {
            return false;
        }
    }
    return true;
}

void FeatureCompatibilityVersion::updateMinWireVersion() {
    // TODO: factor
    WireSpec& wireSpec = WireSpec::instance();
    const auto currentFcv = serverGlobalParams.featureCompatibility.getVersion();
    if (currentFcv == FCVParams::kLatest ||
        (serverGlobalParams.featureCompatibility.isUpgradingOrDowngrading() &&
         currentFcv != FCVParams::kUpgradingFromLastLTSToLastContinuous)) {
        // FCV == kLatest or FCV is upgrading/downgrading to or from kLatest.
        WireSpec::Specification newSpec = *wireSpec.get();
        newSpec.incomingInternalClient.minWireVersion = LATEST_WIRE_VERSION;
        newSpec.outgoing.minWireVersion = LATEST_WIRE_VERSION;
        wireSpec.reset(std::move(newSpec));
    } else if (currentFcv == FCVParams::kUpgradingFromLastLTSToLastContinuous ||
               currentFcv == FCVParams::kLastContinuous) {
        // FCV == kLastContinuous or upgrading to kLastContinuous.
        WireSpec::Specification newSpec = *wireSpec.get();
        newSpec.incomingInternalClient.minWireVersion = LAST_CONT_WIRE_VERSION;
        newSpec.outgoing.minWireVersion = LAST_CONT_WIRE_VERSION;
        wireSpec.reset(std::move(newSpec));
    } else {
        invariant(currentFcv == FCVParams::kLastLTS);
        WireSpec::Specification newSpec = *wireSpec.get();
        newSpec.incomingInternalClient.minWireVersion = LAST_LTS_WIRE_VERSION;
        newSpec.outgoing.minWireVersion = LAST_LTS_WIRE_VERSION;
        wireSpec.reset(std::move(newSpec));
    }
}

void FeatureCompatibilityVersion::initializeForStartup(OperationContext* opCtx) {
    // Global write lock must be held.
    invariant(opCtx->lockState()->isW());
    auto featureCompatibilityVersion = findFcvDocument(opCtx);
    if (!featureCompatibilityVersion) {
        return;
    }

    // If the server configuration collection already contains a valid featureCompatibilityVersion
    // document, cache it in-memory as a server parameter.
    auto swVersion = FeatureCompatibilityVersionParser::parse(*featureCompatibilityVersion);

    // Note this error path captures all cases of an FCV document existing, but with any
    // unacceptable value. This includes unexpected cases with no path forward such as the FCV value
    // not being a string.
    if (!swVersion.isOK()) {
        uassertStatusOK({ErrorCodes::MustDowngrade,
                         str::stream()
                             << "UPGRADE PROBLEM: Found an invalid featureCompatibilityVersion "
                                "document (ERROR: "
                             << swVersion.getStatus()
                             << "). If the current featureCompatibilityVersion is below 4.4, see "
                                "the documentation on upgrading at "
                             << feature_compatibility_version_documentation::kUpgradeLink << "."});
    }

    auto version = swVersion.getValue();
    serverGlobalParams.mutableFeatureCompatibility.setVersion(version);
    FeatureCompatibilityVersion::updateMinWireVersion();

    // On startup, if the version is in an upgrading or downgrading state, print a warning.
    if (serverGlobalParams.featureCompatibility.isUpgradingOrDowngrading()) {
        LOGV2_WARNING_OPTIONS(
            4978301,
            {logv2::LogTag::kStartupWarnings},
            "A featureCompatibilityVersion upgrade/downgrade did not complete. To fix this, use "
            "the setFeatureCompatibilityVersion command to resume the upgrade/downgrade",
            "currentfeatureCompatibilityVersion"_attr =
                FeatureCompatibilityVersionParser::toString(version));
    }
}

// Fatally asserts if the featureCompatibilityVersion document is not initialized, when required.
void FeatureCompatibilityVersion::fassertInitializedAfterStartup(OperationContext* opCtx) {
    Lock::GlobalWrite lk(opCtx);
    const auto replProcess = repl::ReplicationProcess::get(opCtx);
    const auto& replSettings = repl::ReplicationCoordinator::get(opCtx)->getSettings();

    // The node did not complete the last initial sync. If the initial sync flag is set and we are
    // part of a replica set, we expect the version to be initialized as part of initial sync after
    // startup.
    bool needInitialSync = replSettings.usingReplSets() && replProcess &&
        replProcess->getConsistencyMarkers()->getInitialSyncFlag(opCtx);
    if (needInitialSync) {
        return;
    }

    auto fcvDocument = findFcvDocument(opCtx);

    auto const storageEngine = opCtx->getServiceContext()->getStorageEngine();
    auto dbNames = storageEngine->listDatabases();
    bool nonLocalDatabases = std::any_of(dbNames.begin(), dbNames.end(), [](auto name) {
        return name != NamespaceString::kLocalDb;
    });

    // Fail to start up if there is no featureCompatibilityVersion document and there are non-local
    // databases present.
    if (!fcvDocument && nonLocalDatabases) {
        LOGV2_FATAL_NOTRACE(40652,
                            "Unable to start up mongod due to missing featureCompatibilityVersion "
                            "document. Please run with --repair to restore the document.");
    }

    // If we are part of a replica set and are started up with no data files, we do not set the
    // featureCompatibilityVersion until a primary is chosen. For this case, we expect the in-memory
    // featureCompatibilityVersion parameter to still be uninitialized until after startup.
    if (isWriteableStorageEngine() && (!replSettings.usingReplSets() || nonLocalDatabases)) {
        invariant(serverGlobalParams.featureCompatibility.isVersionInitialized());
    }
}

/**
 * Read-only server parameter for featureCompatibilityVersion.
 */
// No ability to specify 'none' as set_at type,
// so use 'startup' in the IDL file, then override to none here.
FeatureCompatibilityVersionParameter::FeatureCompatibilityVersionParameter(StringData name,
                                                                           ServerParameterType)
    : ServerParameter(ServerParameterSet::getGlobal(), name, false, false) {}

void FeatureCompatibilityVersionParameter::append(OperationContext* opCtx,
                                                  BSONObjBuilder& b,
                                                  const std::string& name) {
    uassert(ErrorCodes::UnknownFeatureCompatibilityVersion,
            str::stream() << name << " is not yet known.",
            serverGlobalParams.featureCompatibility.isVersionInitialized());

    FeatureCompatibilityVersionDocument fcvDoc;
    BSONObjBuilder featureCompatibilityVersionBuilder(b.subobjStart(name));
    auto version = serverGlobalParams.featureCompatibility.getVersion();
    FCVTransitions::const_iterator transition;
    if (serverGlobalParams.featureCompatibility.isUpgradingOrDowngrading()) {
        transition = std::find_if(transitions.begin(), transitions.end(), [&](const auto& value) {
            const auto& key = value.first;
            // Transition table entry where fromVersion == version.
            return key.first == version;
        });
    } else {
        transition = std::find_if(transitions.begin(), transitions.end(), [&](const auto& value) {
            const auto& key = value.first;
            // Transition table entry where fromVersion == toVersion == version.
            return key.first == version && key.second == version;
        });
    }
    fassert(0, transition != transitions.end());
    setFCVDocumentFields(fcvDoc, *transition);
    featureCompatibilityVersionBuilder.appendElements(fcvDoc.toBSON().removeField("_id"));
}

Status FeatureCompatibilityVersionParameter::setFromString(const std::string&) {
    return {ErrorCodes::IllegalOperation,
            str::stream() << name() << " cannot be set via setParameter. See "
                          << feature_compatibility_version_documentation::kCompatibilityLink
                          << "."};
}

}  // namespace mongo
