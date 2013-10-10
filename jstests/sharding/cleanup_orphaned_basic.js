//
// Basic tests of cleanupOrphaned.
//

/*****************************************************************************
 * Unsharded mongod.
 ****************************************************************************/

// cleanupOrphaned succeeds against unsharded mongod.
var mongod = startMongodTest();
assert.commandWorked(
    mongod.getDB('admin').runCommand({cleanupOrphaned: 'foo.bar'}));

/*****************************************************************************
 * Bad invocations of cleanupOrphaned command.
 ****************************************************************************/

var st = new ShardingTest({
    other: {
        rs: true,
        rsOptions: {nodes: 2}
    }
});

st.stopBalancer();

var mongos = st.s0;
var mongosAdmin = mongos.getDB('admin');
var coll = mongos.getCollection('foo.bar');

// cleanupOrphaned fails against mongos ('no such command'): it must be run
// on mongod.
assert.commandFailed(
    mongosAdmin.runCommand({cleanupOrphaned: coll.getFullName()}));

// cleanupOrphaned must be run on admin DB.
var shardFooDB = st.shard0.getDB('foo');
assert.commandFailed(
    shardFooDB.runCommand({cleanupOrphaned: coll.getFullName()}));

var shardAdmin = st.shard0.getDB('admin');

/*****************************************************************************
 * Unsharded namespaces in sharded cluster.
 ****************************************************************************/

// cleanupOrphaned succeeds on unsharded database in sharded cluster.
assert.commandWorked(
    shardAdmin.runCommand({cleanupOrphaned: coll.getFullName()}));

// cleanupOrphaned fails against unsharded collection in sharded DB.
assert.commandWorked(mongosAdmin.runCommand({
    enableSharding: coll.getDB().getName()
}));

assert.commandWorked(
    shardAdmin.runCommand({cleanupOrphaned: coll.getFullName()}));

/*****************************************************************************
 * Bad startingFromKeys.
 ****************************************************************************/

// cleanupOrphaned fails if startingFrom doesn't match shard key pattern.
assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: coll.getFullName(),
    key: {_id: 1}
}));

// Doesn't match number of keys.
assert.commandFailed(shardAdmin.runCommand({
    cleanupOrphaned: coll.getFullName(),
    startingFromKey: {someKey: 'someValue', someOtherKey: 1}
}));

// Matches number of keys but not key name.
// TODO: re-enable after SERVER-11104
//assert.commandFailed(shardAdmin.runCommand({
//    cleanupOrphaned: coll.getFullName(),
//    startingFromKey: {someKey: 'someValue'}
//}));

var coll2 = mongos.getCollection('foo.baz');

// cleanupOrphaned fails if startingFrom doesn't match shard key pattern.
assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: coll2.getFullName(),
    key: {a:1, b:1}
}));


// Doesn't match number of keys.
assert.commandFailed(shardAdmin.runCommand({
    cleanupOrphaned: coll2.getFullName(),
    startingFromKey: {someKey: 'someValue'}
}));

// Matches number of keys but not key name.
// TODO: re-enable after SERVER-11104
//assert.commandFailed(shardAdmin.runCommand({
//    cleanupOrphaned: coll2.getFullName(),
//    startingFromKey: {a: 'someValue', c: 1}
//}));

/*****************************************************************************
 * Replication halted.
 ****************************************************************************/

// Put low chunk on shard 0, high chunk on shard 1. One doc in each, plus an
// orphan on shard 0.
assert.commandWorked(mongosAdmin.runCommand({
    split: coll.getFullName(),
    middle: {_id: 0}
}));

var shards = mongos.getCollection('config.shards').find().toArray();
var cmd = {
    moveChunk: coll.getFullName(),
    find: {_id: 0},
    to: shards[1]._id
};

printjson(cmd);
printjson(mongosAdmin.runCommand(cmd));

var fooDB = mongos.getDB('foo');
fooDB.getCollection('bar').insert([{_id: -1}, {_id: 1}]);
assert(!fooDB.getLastError(), fooDB.getLastError());

shardFooDB.getCollection('bar').insert({_id:2});  // An orphan on shard 0.
assert(!shardFooDB.getLastError(2));

// cleanupOrphaned should fail when majority of replica set can't catch up.
// Halt replication on shard 0's secondary, and shorten the primary's wtimeout
// from one hour to one second to speed up the test.
jsTest.log('stopping replication');
var secondaryAdmin = st.rs0.getSecondary().getDB('admin');
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

jsTest.log('running cleanupOrphaned with replication stopped');
var response = shardAdmin.runCommand({
    cleanupOrphaned: coll.getFullName(),
    secondaryThrottle: false
});

// "moveChunk repl sync timed out"
printjson(response);
assert.commandFailed(response);
assert.neq(-1, response.errmsg.indexOf('timed out'), response.errmsg);

jsTest.log('completed cleanupOrphaned with replication stopped');
assert.commandWorked(secondaryAdmin.runCommand({
    configureFailPoint: 'rsSyncApplyStop',
    mode: 'off'
}));

// Once replication catches up, orphan will be gone from secondary.
var secondaryCollection = st.rs0.getSecondary().getCollection('foo.bar');

// Wait up to 10 seconds for replication to resume and remove orphan from
// secondary.
for (var i = 0; i < 100; i++) {
    if (secondaryCollection.count() != 1) { sleep(100 /* milliseconds */); }
}

assert.eq(1, secondaryCollection.count());


/*****************************************************************************
 * Config server down.
 ****************************************************************************/

jsTest.log('Killing config server.');
MongoRunner.stopMongod(st.config0.port);
assert(MongoRunner.isStopped(st.config0.port));

jsTest.log('running cleanupOrphaned with config server down');
var response = shardAdmin.runCommand({
    cleanupOrphaned: coll.getFullName()
});

printjson(response);
assert.commandWorked(response);

st.stop();
