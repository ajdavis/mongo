//
// Trivial tests of cleanupOrphaned command permissions.
// TODO: refactor with any general testing of commands and 2.6-era roles.
//

var st = new ShardingTest({
    auth: true,
    keyFile: 'jstests/libs/key1',
    other: {useHostname: false}
});

st.stopBalancer();

var mongos = st.s0;
var mongosAdmin = mongos.getDB('admin');
var coll = mongos.getCollection('foo.bar');

assert.commandWorked(mongosAdmin.runCommand({
    enableSharding: coll.getDB().getName()
}));

assert.commandWorked(mongosAdmin.runCommand({
    shardCollection: coll.getFullName(),
    key: {_id: 'hashed'}
}));


// cleanupOrphaned requires auth as admin user.
var shardAdmin = st.shard0.getDB('admin');
shardAdmin.addUser('admin', 'x', ['clusterAdmin']);
assert.unauthorized(shardAdmin.runCommand({cleanupOrphaned: 'foo.bar'}));
shardAdmin.auth('admin', 'x');
assert.commandWorked(shardAdmin.runCommand({cleanupOrphaned: 'foo.bar'}));
assert.commandWorked(shardAdmin.logout());
assert.unauthorized(shardAdmin.runCommand({cleanupOrphaned: 'foo.bar'}));

var fooDB = st.shard0.getDB('foo');
fooDB.addUser('user', 'x', ['readWrite', 'dbAdmin']);
shardAdmin.logout();
fooDB.auth('user', 'x');
assert.unauthorized(shardAdmin.runCommand({cleanupOrphaned: 'foo.bar'}));

st.stop();
