// Test cases for explain().indexSpec, SERVER-8688

// + means, needs work
// * means, done
//
// * BasicCursor
//    * ForwardCappedCursor
//    * ReverseCappedCursor
//    * ReverseCursor
// * BtreeCursor
// * GeoCursorBase
//    * GeoBrowse
//    * GeoSearchCursor
// * IntervalBtreeCursor ONLY FOR COUNTS
// ? MultiCursor INSIDE QO
// ? QueryOptimizerCursor INSIDE QO AND DISTINCT??
// + S2Cursor
// + S2NearCursor

/* Assert cursorType (e.g. BasicCursor or ReverseCursor) is in the explain
 * output, and that there's no indexSpec.
 */
function assertBasic(cursorType, explain) {
    assert.eq(explain.cursor, cursorType);
    assert.eq(
        undefined,
        explain.indexSpec,
        "Explain should have no 'indexSpec' field"
    );
}

/* Assert cursorName is in the explain output and that explain.indexSpec
 * matches the system.indexes entry.
 */
function assertBtree(cursorName, collection, explain) {
    var explainIndexSpec = explain.indexSpec,
        indexName = cursorName.split(' ')[1],
        collectionIndexSpec = db.system.indexes.findOne({
            ns: collection.getFullName(),
            name: indexName
        });

    assert.eq(explain.cursor, cursorName);
    assert.neq(
        undefined, explainIndexSpec,
        "Explain should have an 'indexSpec' field"
    );

    assert.eq(collectionIndexSpec, explainIndexSpec);
}

/* Find a cursor's entry in the 'allPlans' array of explain().
 */
function findInAllPlans(explain, cursorName) {
    assert.neq(
        explain.allPlans, undefined,
        'No allPlans in explain output: Did you forget to explain(true)?'
    );

    for (var i = 0; i < explain.allPlans.length; i++) {
        var plan = explain.allPlans[i];
        if (plan.cursor == cursorName)
            return plan;
    }

    return undefined;
}

/* Check that a cursor's indexSpec is in the 'allPlans' array of explain().
 */
function assertBtreeInAllPlans(cursorName, collection, explain) {
    var subExplain = findInAllPlans(explain, cursorName);
    assertBtree(cursorName, collection, subExplain);
}

/* Assert cursorName is in the explain output and that explain.indexSpec
 * matches the system.indexes entry.
 */
function assertGeo(cursorName, indexName, collection, explain) {
    var explainIndexSpec = explain.indexSpec,
        collectionIndexSpec = db.system.indexes.findOne({
            ns: collection.getFullName(),
            name: indexName
        });

    assert.eq(explain.cursor, cursorName);
    assert.neq(
        undefined, explainIndexSpec,
        "Explain should have an 'indexSpec' field"
    );

    assert.eq(collectionIndexSpec, explainIndexSpec);
}

/* Check that a cursor's indexSpec is in the 'allPlans' array of explain().
 */
function assertGeoInAllPlans(cursorName, indexName, collection, explain) {
    var subExplain = findInAllPlans(explain, cursorName);
    assertGeo(cursorName, indexName, collection, subExplain);
}

var t = db.jstests_explaind, tcapped = db.jstests_explaind_capped;
t.drop();
t.insert({}); // Otherwise server won't use a ReverseCursor
tcapped.drop();

db.createCollection('jstests_explaind_capped', {capped: true, size: 10000});

// BasicCursor and subclasses
assertBasic('BasicCursor', t.find().explain());
assertBasic('ReverseCursor', t.find().sort({$natural:-1}).explain());
assertBasic('ForwardCappedCursor', tcapped.find().explain());
assertBasic('ReverseCappedCursor', tcapped.find().sort({$natural:-1}).explain());

// BtreeCursor
t.ensureIndex({a: 1});
t.ensureIndex({b: -1}, {sparse: true, unique: true});

var explain = t.find({a: 'foo', b: 'bar'}).explain(true);
assertBtree('BtreeCursor a_1', t, explain);
assertBtreeInAllPlans('BtreeCursor a_1', t, explain);
assertBtreeInAllPlans('BtreeCursor b_-1', t, explain);

assertBasic('BasicCursor', findInAllPlans(explain, "BasicCursor"));

// Only chosen plan's indexSpec is included without 'verbose'
var explainNonVerbose = t.find({a: 'foo'}).explain();
assertBtree('BtreeCursor a_1', t, explainNonVerbose);
assert.eq(undefined, explainNonVerbose.allPlans);

// GeoCursor subclasses
t.drop();
t.createIndex({loc: '2d'});

var cursorGeoBrowse = t.find({loc: {$within: {$centerSphere: [[0, 0], 1]}}}),
    explainGeoBrowse = cursorGeoBrowse.explain(true);

assertGeo('GeoBrowse-circle', 'loc_2d', t, explainGeoBrowse);
assertGeoInAllPlans('GeoBrowse-circle', 'loc_2d', t, explainGeoBrowse);

var cursorGeoSearch = t.find({loc: {$near: [0, 0]}, a:1}),
    explainGeoSearch = cursorGeoSearch.explain(true);

assertGeo('GeoSearchCursor', 'loc_2d', t, explainGeoSearch);
assertGeoInAllPlans('GeoSearchCursor', 'loc_2d', t, explainGeoSearch);

// S2Cursor, S2NearCursor
t.drop();
var pt = {type: 'Point', coordinates: [0, 0]};
t.insert({loc: pt});
t.ensureIndex({loc: '2dsphere'});

var cursorS2 = t.find({loc: {$within: {$centerSphere: [[0, 0], 1]}}}),
    explainS2 = cursorS2.explain(true);

assertGeo('S2Cursor', 'loc_2dsphere', t, explainS2);
assertGeoInAllPlans('S2Cursor', 'loc_2dsphere', t, explainS2);

var cursorS2Near = t.find({'loc': {'$near': {'$geometry': pt, $maxDistance: 1}}}),
    explainS2Near = cursorS2Near.explain(true);

assertGeo('S2NearCursor', 'loc_2dsphere', t, explainS2Near);
assertGeoInAllPlans('S2NearCursor', 'loc_2dsphere', t, explainS2Near);

// Final cleanup
t.drop();
tcapped.drop();
