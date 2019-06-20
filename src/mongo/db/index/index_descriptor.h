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

#pragma once

#include "mongo/db/index/index_descriptor_fwd.h"

#include <set>
#include <string>

#include "mongo/db/catalog/index_catalog.h"
#include "mongo/db/index/multikey_paths.h"
#include "mongo/db/index_names.h"
#include "mongo/db/jsobj.h"
#include "mongo/db/server_options.h"

namespace mongo {

class Collection;
class IndexCatalogEntry;
class IndexCatalogEntryContainer;
class OperationContext;

/**
 * A cache of information computed from the memory-mapped per-index data (OnDiskIndexData).
 * Contains accessors for the various immutable index parameters, and an accessor for the
 * mutable "head" pointer which is index-specific.
 *
 * All synchronization is the responsibility of the caller.
 */
class IndexDescriptor {
public:
    enum class IndexVersion { kV1 = 1, kV2 = 2 };
    static constexpr IndexVersion kLatestIndexVersion = IndexVersion::kV2;

    static constexpr StringData k2dIndexBitsFieldName = "bits"_sd;
    static constexpr StringData k2dIndexMinFieldName = "min"_sd;
    static constexpr StringData k2dIndexMaxFieldName = "max"_sd;
    static constexpr StringData k2dsphereCoarsestIndexedLevel = "coarsestIndexedLevel"_sd;
    static constexpr StringData k2dsphereFinestIndexedLevel = "finestIndexedLevel"_sd;
    static constexpr StringData k2dsphereVersionFieldName = "2dsphereIndexVersion"_sd;
    static constexpr StringData kBackgroundFieldName = "background"_sd;
    static constexpr StringData kCollationFieldName = "collation"_sd;
    static constexpr StringData kDefaultLanguageFieldName = "default_language"_sd;
    static constexpr StringData kDropDuplicatesFieldName = "dropDups"_sd;
    static constexpr StringData kExpireAfterSecondsFieldName = "expireAfterSeconds"_sd;
    static constexpr StringData kGeoHaystackBucketSize = "bucketSize"_sd;
    static constexpr StringData kIndexNameFieldName = "name"_sd;
    static constexpr StringData kIndexVersionFieldName = "v"_sd;
    static constexpr StringData kKeyPatternFieldName = "key"_sd;
    static constexpr StringData kLanguageOverrideFieldName = "language_override"_sd;
    static constexpr StringData kNamespaceFieldName = "ns"_sd;
    static constexpr StringData kPartialFilterExprFieldName = "partialFilterExpression"_sd;
    static constexpr StringData kPathProjectionFieldName = "wildcardProjection"_sd;
    static constexpr StringData kSparseFieldName = "sparse"_sd;
    static constexpr StringData kStorageEngineFieldName = "storageEngine"_sd;
    static constexpr StringData kTextVersionFieldName = "textIndexVersion"_sd;
    static constexpr StringData kUniqueFieldName = "unique"_sd;
    static constexpr StringData kWeightsFieldName = "weights"_sd;

    /**
     * Given a BSONObj representing an index spec, returns a new owned BSONObj which is identical to
     * 'spec' after replacing the 'ns' field with the value of 'newNs'.
     */
    static BSONObj renameNsInIndexSpec(BSONObj spec, const NamespaceString& newNs);

    /**
     * infoObj is a copy of the index-describing BSONObj contained in the catalog.
     */
    IndexDescriptor(Collection* collection, const std::string& accessMethodName, BSONObj infoObj);

    /**
     * Returns true if the specified index version is supported, and returns false otherwise.
     */
    static bool isIndexVersionSupported(IndexVersion indexVersion);

    /**
     * Returns a set of the currently supported index versions.
     */
    static std::set<IndexVersion> getSupportedIndexVersions();

    /**
     * Returns Status::OK() if indexes of version 'indexVersion' are allowed to be created, and
     * returns ErrorCodes::CannotCreateIndex otherwise.
     */
    static Status isIndexVersionAllowedForCreation(
        IndexVersion indexVersion,
        const ServerGlobalParams::FeatureCompatibility& featureCompatibility,
        const BSONObj& indexSpec);

    /**
     * Returns the index version to use if it isn't specified in the index specification.
     */
    static IndexVersion getDefaultIndexVersion();

    //
    // Information about the key pattern.
    //

    /**
     * Return the user-provided index key pattern.
     * Example: {geo: "2dsphere", nonGeo: 1}
     * Example: {foo: 1, bar: -1}
     */
    const BSONObj& keyPattern() const {
        return _keyPattern;
    }

    /**
     * Return the path projection spec, if one exists. This is only applicable for '$**' indexes.
     */
    const BSONObj& pathProjection() const {
        return _projection;
    }

    /**
     * Test only command for testing behavior resulting from an incorrect key
     * pattern.
     */
    void setKeyPatternForTest(BSONObj newKeyPattern) {
        _keyPattern = newKeyPattern;
    }

    // How many fields do we index / are in the key pattern?
    int getNumFields() const {
        return _numFields;
    }

    //
    // Information about the index's namespace / collection.
    //

    // Return the name of the index.
    const std::string& indexName() const {
        return _indexName;
    }

    // Return the name of the indexed collection.
    const NamespaceString& parentNS() const {
        return _parentNS;
    }

    // Return the name of the access method we must use to access this index's data.
    const std::string& getAccessMethodName() const {
        return _accessMethodName;
    }

    // Returns the type of the index associated with this descriptor.
    IndexType getIndexType() const {
        return _indexType;
    }

    //
    // Properties every index has
    //

    // Return what version of index this is.
    IndexVersion version() const {
        return _version;
    }

    // May each key only occur once?
    bool unique() const {
        return _unique;
    }

    // Is this index sparse?
    bool isSparse() const {
        return _sparse;
    }

    // Is this a partial index?
    bool isPartial() const {
        return _partial;
    }

    // Is this index multikey?
    bool isMultikey(OperationContext* opCtx) const;

    MultikeyPaths getMultikeyPaths(OperationContext* opCtx) const;

    bool isIdIndex() const {
        return _isIdIndex;
    }

    // Return a (rather compact) std::string representation.
    std::string toString() const {
        return _infoObj.toString();
    }

    // Return the info object.
    const BSONObj& infoObj() const {
        return _infoObj;
    }

    // Both the collection and the catalog must outlive the IndexDescriptor
    const Collection* getCollection() const {
        return _collection;
    }
    const IndexCatalog* getIndexCatalog() const;

    bool areIndexOptionsEquivalent(const IndexDescriptor* other) const;

    void setNs(NamespaceString ns);

    const BSONObj& collation() const {
        return _collation;
    }

    const BSONObj& partialFilterExpression() const {
        return _partialFilterExpression;
    }

    static bool isIdIndexPattern(const BSONObj& pattern) {
        BSONObjIterator i(pattern);
        BSONElement e = i.next();
        //_id index must have form exactly {_id : 1} or {_id : -1}.
        // Allows an index of form {_id : "hashed"} to exist but
        // do not consider it to be the primary _id index
        if (!(strcmp(e.fieldName(), "_id") == 0 && (e.numberInt() == 1 || e.numberInt() == -1)))
            return false;
        return i.next().eoo();
    }

private:
    // Related catalog information of the parent collection
    Collection* _collection;

    // What access method should we use for this index?
    std::string _accessMethodName;

    IndexType _indexType;

    // The BSONObj describing the index.  Accessed through the various members above.
    BSONObj _infoObj;

    // --- cached data from _infoObj

    int64_t _numFields;  // How many fields are indexed?
    BSONObj _keyPattern;
    BSONObj _projection;
    std::string _indexName;
    NamespaceString _parentNS;
    bool _isIdIndex;
    bool _sparse;
    bool _unique;
    bool _partial;
    IndexVersion _version;
    BSONObj _collation;
    BSONObj _partialFilterExpression;

    // only used by IndexCatalogEntryContainer to do caching for perf
    // users not allowed to touch, and not part of API
    IndexCatalogEntry* _cachedEntry;

    friend class IndexCatalog;
    friend class IndexCatalogEntryImpl;
    friend class IndexCatalogEntryContainer;
};

}  // namespace mongo
