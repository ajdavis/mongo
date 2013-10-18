//
// Tests cleanupOrphaned with replication halted.
//

load('./jstests/libs/chunk_manipulation_util.js');
load('./jstests/libs/cleanup_orphaned_util.js');

var st = new ShardingTest({
    other: {
        rs: true,
        rsOptions: {nodes: 2}
    }
});

st.stopBalancer();

var mongos = st.s0,
    mongosAdmin = mongos.getDB('admin'),
    dbName = 'foo',
    collectionName = 'bar',
    ns = dbName + '.' + collectionName,
    coll = mongos.getCollection(ns),
    secondaryAdmin = st.rs0.getSecondary().getDB('admin'),
    shardAdmin = st.shard0.getDB('admin');

assert.commandWorked(mongosAdmin.runCommand({
    enableSharding: coll.getDB().getName()
}));

assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: ns,
    key: {_id: 1}
}));

// Put low chunk on shard 0, high chunk on shard 1. One doc in each, plus an
// orphan on shard 0.
assert.commandWorked(mongosAdmin.runCommand({
    split: ns,
    middle: {_id: 0}
}));

var shards = mongos.getCollection('config.shards').find().toArray();
assert.commandWorked(mongosAdmin.runCommand({
    moveChunk: ns,
    find: {_id: 0},
    to: shards[1]._id
}));

var fooDB = mongos.getDB(dbName);
fooDB.getCollection(collectionName).insert([{_id: -1}, {_id: 1}]);
assert(!fooDB.getLastError(), fooDB.getLastError());

var shardFooDB = st.shard0.getDB(dbName);
shardFooDB.getCollection(collectionName).insert({_id:2});  // An orphan on shard 0.
assert(!shardFooDB.getLastError(2));

// cleanupOrphaned should fail when majority of replica set can't catch up.
// Halt replication on shard 0's secondary, and shorten the primary's wtimeout
// from one hour to one second to speed up the test.
jsTest.log('Stopping replication.');
assert.commandWorked(secondaryAdmin.runCommand({
    configureFailPoint: 'rsSyncApplyStop',
    mode: 'alwaysOn'
}));

jsTest.log('Configuring rangeDeleterWTimeout fail point.');
assert.commandWorked(shardAdmin.runCommand({
    configureFailPoint: 'rangeDeleterWTimeout',
    mode: 'alwaysOn',
    data: {seconds: 1}
}));

jsTest.log('Running cleanupOrphaned with replication stopped.');
response = shardAdmin.runCommand({
    cleanupOrphaned: ns,
    secondaryThrottle: false
});

// "moveChunk repl sync timed out".
printjson(response);
assert.commandFailed(response);
assert.neq(-1, response.errmsg.indexOf('timed out'), response.errmsg);

jsTest.log('Completed cleanupOrphaned with replication stopped.');
assert.commandWorked(secondaryAdmin.runCommand({
    configureFailPoint: 'rsSyncApplyStop',
    mode: 'off'
}));

// Once replication catches up, orphan will be gone from secondary.
var secondaryCollection = st.rs0.getSecondary().getCollection(ns);

// Wait for replication to resume and remove orphan from secondary.
assert.soon(function() {
    return 1 == secondaryCollection.count();
}, "Replication didn't delete orphan from secondary");

// Restore default timeout for range deleter.
assert.commandWorked(shardAdmin.runCommand({
    configureFailPoint: 'rangeDeleterWTimeout',
    mode: 'off'
}));
