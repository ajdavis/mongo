//
// Test cleanupOrphaned with a hashed shard key.
//

load('./jstests/libs/cleanup_orphaned_util.js');

function keyGen() {
    var ids = [];
    for (var i = -50; i < 50; i++) { ids.push({a: i}); }
    return ids;
}

var st = new ShardingTest({shards: 2, mongos: 2});
st.stopBalancer();

var mongos = st.s0,
    admin = mongos.getDB('admin'),
    shards = mongos.getCollection('config.shards').find().toArray(),
    coll = mongos.getCollection('foo.bar'),
    shard0Coll = st.shard0.getCollection(coll.getFullName()),
    shard1Coll = st.shard1.getCollection(coll.getFullName()),
    keys = keyGen(),
    orphan = {_id: {a: -100}};

assert.commandWorked(admin.runCommand({
    enableSharding: coll.getDB().getName()
}));

assert.commandWorked(admin.runCommand({
    movePrimary: coll.getDB().getName(),
    to: shards[0]._id
}));

assert.commandWorked(admin.runCommand({
    shardCollection: coll.getFullName(),
    key: {a: 'hashed'}
}));

st.printShardingStatus();

jsTest.log('Inserting some regular docs...');

for (var i = 0; i < keys.length; i++) coll.insert(keys[i]);
assert.eq(null, coll.getDB().getLastError());
assert.eq(keys.length, coll.find().itcount());

jsTest.log('Inserting orphan.');
// Insert the same doc in both shards. It has to be an orphan on one of them.
shard0Coll.insert(orphan);
assert.eq(null, shard0Coll.getDB().getLastError());
shard1Coll.insert(orphan);
assert.eq(null, shard1Coll.getDB().getLastError());
assert.eq(2 + keys.length, shard0Coll.count() + shard1Coll.count());

jsTest.log('Cleaning up orphan...');

cleanupOrphaned(st.shard0, coll.getFullName(), 2);
cleanupOrphaned(st.shard1, coll.getFullName(), 2);

// The doc was an orphan on one of the shards.
assert.eq(1 + keys.length, shard0Coll.count() + shard1Coll.count());

jsTest.log('DONE!');

st.stop();
