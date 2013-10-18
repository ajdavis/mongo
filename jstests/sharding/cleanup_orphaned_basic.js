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
var dbName = 'foo';
var collectionName = 'bar';
var ns = dbName + '.' + collectionName;
var coll = mongos.getCollection(ns);

// cleanupOrphaned fails against mongos ('no such command'): it must be run
// on mongod.
assert.commandFailed(mongosAdmin.runCommand({cleanupOrphaned: ns}));

// cleanupOrphaned must be run on admin DB.
var shardFooDB = st.shard0.getDB(dbName);
assert.commandFailed(shardFooDB.runCommand({cleanupOrphaned: ns}));

// Must be run on primary.
var secondaryAdmin = st.rs0.getSecondary().getDB('admin');
var response = secondaryAdmin.runCommand({cleanupOrphaned: ns});
print('cleanupOrphaned on secondary:');
printjson(response);
assert.commandFailed(response);

// Bad ns.
// TODO: re-enable?
var shardAdmin = st.shard0.getDB('admin');
//var badNS = ' \\/."*<>:|?';
//response = shardAdmin.runCommand({cleanupOrphaned: badNS});
//print('cleanupOrphaned on bad NS:');
//printjson(response);
//assert.commandFailed(response);

/*****************************************************************************
 * Unsharded namespaces.
 ****************************************************************************/

// cleanupOrphaned succeeds on unsharded database.
assert.commandWorked(shardAdmin.runCommand({cleanupOrphaned: ns}));

// cleanupOrphaned succeeds on unsharded collection.
assert.commandWorked(mongosAdmin.runCommand({
    enableSharding: coll.getDB().getName()
}));

assert.commandWorked(shardAdmin.runCommand({cleanupOrphaned: ns}));

/*****************************************************************************
 * Empty shard.
 ****************************************************************************/

response = st.shard1.getDB('admin').runCommand({cleanupOrphaned: ns});
assert.commandWorked(response);
assert.eq(null, response.stoppedAtKey);

assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: ns,
    key: {_id: 1}
}));

// Collection's home is shard0, there are no chunks assigned to shard1.
st.shard1.getCollection(ns).insert({});
assert.eq(null, st.shard1.getDB(dbName).getLastError());
assert.eq(1, st.shard1.getCollection(ns).count());
response = st.shard1.getDB('admin').runCommand({cleanupOrphaned: ns});
assert.commandWorked(response);
assert.eq(null, response.stoppedAtKey);
assert.eq(
    0, st.shard1.getCollection(ns).count(),
    "cleanupOrphaned didn't delete orphan on empty shard.");

/*****************************************************************************
 * Bad startingFromKeys.
 ****************************************************************************/


// startingFromKey of MaxKey.
response = shardAdmin.runCommand({
    cleanupOrphaned: ns,
    startingFromKey: {_id: MaxKey}
});
assert.commandWorked(response);
assert.eq(null, response.stoppedAtKey);

// startingFromKey doesn't match number of fields in shard key.
assert.commandFailed(shardAdmin.runCommand({
    cleanupOrphaned: ns,
    startingFromKey: {someKey: 'someValue', someOtherKey: 1}
}));

// startingFromKey matches number of fields in shard key but not field names.
// TODO: re-enable after SERVER-11104
//assert.commandFailed(shardAdmin.runCommand({
//    cleanupOrphaned: ns,
//    startingFromKey: {someKey: 'someValue'}
//}));

var coll2 = mongos.getCollection('foo.baz');

assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: coll2.getFullName(),
    key: {a:1, b:1}
}));


// startingFromKey doesn't match number of fields in shard key.
assert.commandFailed(shardAdmin.runCommand({
    cleanupOrphaned: coll2.getFullName(),
    startingFromKey: {someKey: 'someValue'}
}));

// startingFromKey matches number of fields in shard key but not field names.
// TODO: re-enable after SERVER-11104
//assert.commandFailed(shardAdmin.runCommand({
//    cleanupOrphaned: coll2.getFullName(),
//    startingFromKey: {a: 'someValue', c: 1}
//}));

/*****************************************************************************
 * Config server down.
 ****************************************************************************/

jsTest.log('Killing config server.');
MongoRunner.stopMongod(st.config0.port);
assert(MongoRunner.isStopped(st.config0.port));

jsTest.log('Running cleanupOrphaned with config server down.');
assert.commandWorked(shardAdmin.runCommand({cleanupOrphaned: ns}));
st.stop();
