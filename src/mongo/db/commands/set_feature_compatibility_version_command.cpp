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

#define MONGO_LOGV2_DEFAULT_COMPONENT ::mongo::logv2::LogComponent::kDefault

#include "mongo/platform/basic.h"

#include "mongo/db/auth/authorization_session.h"
#include "mongo/db/catalog/coll_mod.h"
#include "mongo/db/catalog/database.h"
#include "mongo/db/catalog/database_holder.h"
#include "mongo/db/commands.h"
#include "mongo/db/commands/feature_compatibility_version.h"
#include "mongo/db/commands/feature_compatibility_version_documentation.h"
#include "mongo/db/commands/feature_compatibility_version_parser.h"
#include "mongo/db/commands/set_feature_compatibility_version_gen.h"
#include "mongo/db/concurrency/d_concurrency.h"
#include "mongo/db/db_raii.h"
#include "mongo/db/dbdirectclient.h"
#include "mongo/db/index_builds_coordinator.h"
#include "mongo/db/namespace_string.h"
#include "mongo/db/ops/write_ops.h"
#include "mongo/db/read_write_concern_defaults.h"
#include "mongo/db/repl/repl_client_info.h"
#include "mongo/db/repl/replication_coordinator.h"
#include "mongo/db/s/active_migrations_registry.h"
#include "mongo/db/s/config/sharding_catalog_manager.h"
#include "mongo/db/s/migration_util.h"
#include "mongo/db/s/sharding_state.h"
#include "mongo/db/server_options.h"
#include "mongo/logv2/log.h"
#include "mongo/rpc/get_status_from_command_result.h"
#include "mongo/s/catalog/type_collection.h"
#include "mongo/s/database_version_helpers.h"
#include "mongo/stdx/unordered_set.h"
#include "mongo/util/exit.h"
#include "mongo/util/fail_point.h"
#include "mongo/util/scopeguard.h"

namespace mongo {

using FCVP = FeatureCompatibilityVersionParser;
using FeatureCompatibilityParams = ServerGlobalParams::FeatureCompatibility;
using FCVVersion = FeatureCompatibilityParams::Version;

namespace {

MONGO_FAIL_POINT_DEFINE(featureCompatibilityDowngrade);
MONGO_FAIL_POINT_DEFINE(featureCompatibilityUpgrade);
MONGO_FAIL_POINT_DEFINE(failUpgrading);
MONGO_FAIL_POINT_DEFINE(hangWhileUpgrading);
MONGO_FAIL_POINT_DEFINE(failDowngrading);
MONGO_FAIL_POINT_DEFINE(hangWhileDowngrading);

/**
 * Deletes the persisted default read/write concern document.
 */
void deletePersistedDefaultRWConcernDocument(OperationContext* opCtx) {
    DBDirectClient client(opCtx);
    const auto commandResponse = client.runCommand([&] {
        write_ops::Delete deleteOp(NamespaceString::kConfigSettingsNamespace);
        deleteOp.setDeletes({[&] {
            write_ops::DeleteOpEntry entry;
            entry.setQ(BSON("_id" << ReadWriteConcernDefaults::kPersistedDocumentId));
            entry.setMulti(false);
            return entry;
        }()});
        return deleteOp.serialize({});
    }());
    uassertStatusOK(getStatusFromWriteCommandReply(commandResponse->getCommandReply()));
}

// TODO: explain, especially regarding when lastContinuous == lastLTS
static stdx::unordered_set<std::tuple<FCVVersion, FCVVersion, bool>> FCVTransitions{
    // Upgrade from last-lts to latest:
    std::make_tuple(FeatureCompatibilityParams::kLastLTS,
                    FeatureCompatibilityParams::kUpgradingFromLastLTSToLatest,
                    false),
    std::make_tuple(FeatureCompatibilityParams::kUpgradingFromLastLTSToLatest,
                    FeatureCompatibilityParams::kLatest,
                    false),

    // Upgrade from last-continuous to latest:
    std::make_tuple(FeatureCompatibilityParams::kLastContinuous,
                    FeatureCompatibilityParams::kUpgradingFromLastContinuousToLatest,
                    false),
    std::make_tuple(FeatureCompatibilityParams::kUpgradingFromLastContinuousToLatest,
                    FeatureCompatibilityParams::kLatest,
                    false),

    // Downgrade from latest to last-lts:
    std::make_tuple(FeatureCompatibilityParams::kLatest,
                    FeatureCompatibilityParams::kDowngradingFromLatestToLastLTS,
                    false),
    std::make_tuple(FeatureCompatibilityParams::kDowngradingFromLatestToLastLTS,
                    FeatureCompatibilityParams::kLastLTS,
                    false),

    // Downgrade from latest to last-continuous:
    std::make_tuple(FeatureCompatibilityParams::kLatest,
                    FeatureCompatibilityParams::kDowngradingFromLatestToLastContinuous,
                    false),
    std::make_tuple(FeatureCompatibilityParams::kDowngradingFromLatestToLastContinuous,
                    FeatureCompatibilityParams::kLastContinuous,
                    false),

    // Upgrade from last-lts to last-continuous (permitted from config server):
    std::make_tuple(FeatureCompatibilityParams::kLastLTS,
                    FeatureCompatibilityParams::kUpgradingFromLastLTSToLastContinuous,
                    true),
    std::make_tuple(FeatureCompatibilityParams::kUpgradingFromLastLTSToLastContinuous,
                    FeatureCompatibilityParams::kLastContinuous,
                    true),
};

Status validateFCVChangeRequest(FCVVersion actualVersion,
                                FCVVersion requestedVersion,
                                bool isFromConfigServer) {
    if (FCVTransitions.contains(std::tuple(actualVersion, requestedVersion, isFromConfigServer))) {
        return Status::OK();
    }

    return Status(ErrorCodes::IllegalOperation,
                  str::stream() << "cannot set featureCompatibilityVersion to "
                                << FCVP::toString(requestedVersion)
                                << " while in featureCompatibilityVersion "
                                << FCVP::toString(actualVersion) << ".");
}

/**
 * Sets the minimum allowed feature compatibility version for the cluster. The cluster should not
 * use any new features introduced in binary versions that are newer than the feature compatibility
 * version set.
 *
 * Format:
 * {
 *   setFeatureCompatibilityVersion: <string version>
 * }
 */
class SetFeatureCompatibilityVersionCommand : public BasicCommand {
public:
    SetFeatureCompatibilityVersionCommand()
        : BasicCommand(SetFeatureCompatibilityVersion::kCommandName) {}

    AllowedOnSecondary secondaryAllowed(ServiceContext*) const override {
        return AllowedOnSecondary::kNever;
    }

    virtual bool adminOnly() const {
        return true;
    }

    virtual bool supportsWriteConcern(const BSONObj& cmd) const override {
        return true;
    }

    std::string help() const override {
        std::stringstream h;
        h << "Set the featureCompatibilityVersion used by this cluster. If set to '"
          << FCVP::kLastLTS << "', then features introduced in versions greater than '"
          << FCVP::kLastLTS << "' will be disabled";
        if (FCVP::kLastContinuous != FCVP::kLastLTS) {
            h << " If set to '" << FCVP::kLastContinuous << "', then features introduced in '"
              << FCVP::kLatest << "' will be disabled.";
        }
        h << " If set to '" << FCVP::kLatest << "', then '" << FCVP::kLatest
          << "' features are enabled, and all nodes in the cluster must be binary version "
          << FCVP::kLatest << ". See "
          << feature_compatibility_version_documentation::kCompatibilityLink << ".";
        return h.str();
    }

    Status checkAuthForCommand(Client* client,
                               const std::string& dbname,
                               const BSONObj& cmdObj) const override {
        if (!AuthorizationSession::get(client)->isAuthorizedForActionsOnResource(
                ResourcePattern::forClusterResource(),
                ActionType::setFeatureCompatibilityVersion)) {
            return Status(ErrorCodes::Unauthorized, "Unauthorized");
        }
        return Status::OK();
    }

    bool run(OperationContext* opCtx,
             const std::string& dbname,
             const BSONObj& cmdObj,
             BSONObjBuilder& result) {
        // Always wait for at least majority writeConcern to ensure all writes involved in the
        // upgrade process cannot be rolled back. There is currently no mechanism to specify a
        // default writeConcern, so we manually call waitForWriteConcern upon exiting this command.
        //
        // TODO SERVER-25778: replace this with the general mechanism for specifying a default
        // writeConcern.
        ON_BLOCK_EXIT([&] {
            // Propagate the user's wTimeout if one was given.
            auto timeout =
                opCtx->getWriteConcern().usedDefault ? INT_MAX : opCtx->getWriteConcern().wTimeout;
            WriteConcernResult res;
            auto waitForWCStatus = waitForWriteConcern(
                opCtx,
                repl::ReplClientInfo::forClient(opCtx->getClient()).getLastOp(),
                WriteConcernOptions(repl::ReplSetConfig::kMajorityWriteConcernModeName,
                                    WriteConcernOptions::SyncMode::UNSET,
                                    timeout),
                &res);
            CommandHelpers::appendCommandWCStatus(result, waitForWCStatus, res);
        });

        // Ensure that this operation will be killed by the RstlKillOpThread during step-up or
        // stepdown.
        opCtx->setAlwaysInterruptAtStepDownOrUp();

        // Only allow one instance of setFeatureCompatibilityVersion to run at a time.
        invariant(!opCtx->lockState()->isLocked());
        Lock::ExclusiveLock lk(opCtx->lockState(), FeatureCompatibilityVersion::fcvLock);

        auto request = SetFeatureCompatibilityVersion::parse(
            IDLParserErrorContext("setFeatureCompatibilityVersion"), cmdObj);
        const auto requestedVersion = request.getCommandParameter();
        const auto requestedVersionString = FCVP::serializeVersion(requestedVersion);
        FCVVersion actualVersion = serverGlobalParams.featureCompatibility.getVersion();
        if (request.getDowngradeOnDiskChanges() &&
            (requestedVersion != FeatureCompatibilityParams::kLastContinuous ||
             actualVersion < requestedVersion)) {
            std::stringstream downgradeOnDiskErrorSS;
            downgradeOnDiskErrorSS
                << "cannot set featureCompatibilityVersion to " << requestedVersionString
                << " with '" << SetFeatureCompatibilityVersion::kDowngradeOnDiskChangesFieldName
                << "' set to true. This is only allowed when downgrading to "
                << FCVP::kLastContinuous;
            uasserted(ErrorCodes::IllegalOperation, downgradeOnDiskErrorSS.str());
        }

        if (actualVersion == requestedVersion) {
            // Set the client's last opTime to the system last opTime so no-ops wait for
            // writeConcern.
            repl::ReplClientInfo::forClient(opCtx->getClient()).setLastOpToSystemLastOpTime(opCtx);
            return true;
        }

        uassertStatusOK(validateFCVChangeRequest(
            actualVersion, requestedVersion, request.getFromConfigServer().value_or(false)));

        if (actualVersion < requestedVersion) {
            FeatureCompatibilityVersion::setTargetUpgradeFrom(
                opCtx, actualVersion, requestedVersion);
            {
                // Take the global lock in S mode to create a barrier for operations taking the
                // global IX or X locks. This ensures that either
                //   - The global IX/X locked operation will start after the FCV change, see the
                //     upgrading to the latest FCV and act accordingly.
                //   - The global IX/X locked operation began prior to the FCV change, is acting on
                //     that assumption and will finish before upgrade procedures begin right after
                //     this.
                Lock::GlobalLock lk(opCtx, MODE_S);
            }

            if (failUpgrading.shouldFail())
                return false;

            if (serverGlobalParams.clusterRole == ClusterRole::ShardServer) {
                const auto shardingState = ShardingState::get(opCtx);
                if (shardingState->enabled()) {
                    LOGV2(20500, "Upgrade: submitting orphaned ranges for cleanup");
                    migrationutil::submitOrphanRangesForCleanup(opCtx);
                }
            }

            // Upgrade shards before config finishes its upgrade.
            if (serverGlobalParams.clusterRole == ClusterRole::ConfigServer) {
                uassertStatusOK(
                    ShardingCatalogManager::get(opCtx)->setFeatureCompatibilityVersionOnShards(
                        opCtx, CommandHelpers::appendMajorityWriteConcern(request.toBSON({}))));
            }

            hangWhileUpgrading.pauseWhileSet(opCtx);
            FeatureCompatibilityVersion::unsetTargetUpgradeOrDowngrade(opCtx, requestedVersion);
        } else {
            auto replCoord = repl::ReplicationCoordinator::get(opCtx);
            const bool isReplSet =
                replCoord->getReplicationMode() == repl::ReplicationCoordinator::modeReplSet;

            uassert(ErrorCodes::ConflictingOperationInProgress,
                    str::stream() << "Cannot downgrade the cluster when the replica set config "
                                  << "contains 'newlyAdded' members; wait for those members to "
                                  << "finish its initial sync procedure",
                    !(isReplSet && replCoord->replSetContainsNewlyAddedMembers()));

            // We should make sure the current config w/o 'newlyAdded' members got replicated
            // to all nodes.
            LOGV2(4637904, "Waiting for the current replica set config to propagate to all nodes.");
            // If a write concern is given, we'll use its wTimeout. It's kNoTimeout by default.
            WriteConcernOptions writeConcern(repl::ReplSetConfig::kConfigAllWriteConcernName,
                                             WriteConcernOptions::SyncMode::NONE,
                                             opCtx->getWriteConcern().wTimeout);
            writeConcern.checkCondition = WriteConcernOptions::CheckCondition::Config;
            repl::OpTime fakeOpTime(Timestamp(1, 1), replCoord->getTerm());
            uassertStatusOKWithContext(
                replCoord->awaitReplication(opCtx, fakeOpTime, writeConcern).status,
                "Failed to wait for the current replica set config to propagate to all "
                "nodes");
            LOGV2(4637905, "The current replica set config has been propagated to all nodes.");

            FeatureCompatibilityVersion::setTargetDowngrade(opCtx, requestedVersion);

            {
                // Take the global lock in S mode to create a barrier for operations taking the
                // global IX or X locks. This ensures that either
                //   - The global IX/X locked operation will start after the FCV change, see the
                //     downgrading to 4.4 FCV and act accordingly.
                //   - The global IX/X locked operation began prior to the FCV change, is acting on
                //     that assumption and will finish before downgrade procedures begin right after
                //     this.
                Lock::GlobalLock lk(opCtx, MODE_S);
            }

            if (failDowngrading.shouldFail())
                return false;

            if (serverGlobalParams.clusterRole == ClusterRole::ShardServer) {
                LOGV2(20502, "Downgrade: dropping config.rangeDeletions collection");
                migrationutil::dropRangeDeletionsCollection(opCtx);
            } else if (isReplSet || serverGlobalParams.clusterRole == ClusterRole::ConfigServer) {
                // The default rwc document should only be deleted on plain replica sets and the
                // config server replica set, not on shards or standalones.
                deletePersistedDefaultRWConcernDocument(opCtx);
            }

            // Downgrade shards before config finishes its downgrade.
            if (serverGlobalParams.clusterRole == ClusterRole::ConfigServer) {
                uassertStatusOK(
                    ShardingCatalogManager::get(opCtx)->setFeatureCompatibilityVersionOnShards(
                        opCtx, CommandHelpers::appendMajorityWriteConcern(request.toBSON({}))));
            }

            hangWhileDowngrading.pauseWhileSet(opCtx);
            FeatureCompatibilityVersion::unsetTargetUpgradeOrDowngrade(opCtx, requestedVersion);

            if (request.getDowngradeOnDiskChanges()) {
                invariant(requestedVersion == FeatureCompatibilityParams::kLastContinuous);
                _downgradeOnDiskChanges();
                LOGV2(4875603, "Downgrade of on-disk format complete.");
            }
        }

        return true;
    }

private:
    /*
     * Rolls back any upgraded on-disk changes to reflect the disk format of the last-continuous
     * version.
     */
    void _downgradeOnDiskChanges() {
        LOGV2(4975602,
              "Downgrading on-disk format to reflect the last-continuous version.",
              "last_continuous_version"_attr = FCVP::kLastContinuous);
    }

} setFeatureCompatibilityVersionCommand;

}  // namespace
}  // namespace mongo
