//
// Tests cleanupOrphaned concurrent with moveChunk.
//

load( './jstests/libs/test_chunk_manipulation.js' );

var staticMongod = MongoRunner.runMongod({});  // For startParallelOps.
var options = { separateConfig : true, shardOptions : { verbose : 0 } };
var st = new ShardingTest({ shards : 2, mongos : 1, other : options });
st.stopBalancer();

var mongos = st.s0,
    admin = mongos.getDB( "admin" ),
    shards = mongos.getCollection( "config.shards" ).find().toArray(),
    coll = mongos.getCollection( "foo.bar" ),
    shard0Coll = st.shard0.getCollection( coll + "" ),
    shard1Coll = st.shard1.getCollection( coll + "" ),
    shard0Admin = st.shard0.getDB( "admin" );

// [minKey, 0) and [0, 50) are on shard 0. [50, maxKey) are on shard 1.
assert( admin.runCommand({ enableSharding : coll.getDB() + "" }).ok );
printjson( admin.runCommand({ movePrimary : coll.getDB() + "", to : shards[0]._id }) );
assert( admin.runCommand({ shardCollection : coll + "", key : { _id : 1 } }).ok );
assert( admin.runCommand({ split : coll + "", middle : { _id : 0 } }).ok );
assert( admin.runCommand({ split : coll + "", middle : { _id : 50 } }).ok );
assert( admin.runCommand({ moveChunk : coll + "",
                           find : { _id : 50 },
                           to : shards[1]._id,
                           _waitForDelete : true }).ok );

jsTest.log( "Inserting 100 docs into shard 0...." );
for ( var i = -50; i < 50; i++ ) coll.insert({ _id : i });
assert.eq( null, coll.getDB().getLastError() );
assert.eq( 100, shard0Coll.count() );

jsTest.log( "Inserting 50 docs into shard 1...." );
for ( i = 50; i < 100; i++ ) coll.insert({ _id : i });
assert.eq( null, coll.getDB().getLastError() );
assert.eq( 50, shard1Coll.count() );

//
// Start a moveChunk in the background; pause it at each point in the donor's
// work flow, and try cleanupOrphaned on shard 0 and shard 1.
//

pauseMoveChunkAtStep( st.shard0, 1 );
var joinMoveChunk = moveChunkParallel( st.s0.host,
                                       { _id : 0 },
                                       coll.getFullName(),
                                       shards[1]._id );

// Donor has reloaded shard view.
waitForMoveChunkStep( mongos, 1 );

// Create orphans.
shard0Coll.insert([{ _id: 51 }]);
assert.eq( null, shard0Coll.getDB().getLastError() );
assert.eq( 101, shard0Coll.count() );
shard1Coll.insert([{ _id: -1 }]);
assert.eq( null, shard1Coll.getDB().getLastError() );
assert.eq( 51, shard1Coll.count() );

cleanupOrphaned( st.shard0, coll + "", 2 );
assert.eq( 100, shard0Coll.count() );
cleanupOrphaned( st.shard1, coll + "", 2 );
assert.eq( 50, shard1Coll.count() );

// Donor has updated chunks view and got distributed lock.
proceedToMoveChunkStep( st.shard0, 2 );

// Create orphans.
shard0Coll.insert([{ _id: 51 }]);
assert.eq( null, shard0Coll.getDB().getLastError() );
assert.eq( 101, shard0Coll.count() );
shard1Coll.insert([{ _id: -1 }]);
assert.eq( null, shard1Coll.getDB().getLastError() );
assert.eq( 51, shard1Coll.count() );

cleanupOrphaned( st.shard0, coll + "", 2 );
assert.eq( 100, shard0Coll.count() );
cleanupOrphaned( st.shard1, coll + "", 2 );
assert.eq( 50, shard1Coll.count() );

// Donor has called _recvChunkStart on recipient, recipient ran it.
proceedToMoveChunkStep( st.shard0, 3 );

// Finished sending mods.
proceedToMoveChunkStep( st.shard0, 4 );

// Donor has updated config servers.
proceedToMoveChunkStep( st.shard0, 5 );

// Donor has done post-move delete.
proceedToMoveChunkStep( st.shard0, 6 );

// Donor has returned from moveChunk command.
unpauseMoveChunkAtStep( st.shard0, 6 );
joinMoveChunk();

jsTest.log( "DONE!" );
st.stop();
