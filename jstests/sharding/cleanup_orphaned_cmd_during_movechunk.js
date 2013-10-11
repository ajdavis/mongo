//
// Tests cleanupOrphaned concurrent with moveChunk.
//

load( './jstests/libs/chunk_manipulation_util.js' );
load( './jstests/libs/cleanup_orphaned_util.js' );

var staticMongod = MongoRunner.runMongod({});  // For startParallelOps.
var options = { separateConfig : true, shardOptions : { verbose : 0 } };
var st = new ShardingTest({ shards : 2, mongos : 1, other : options });
st.stopBalancer();

var mongos = st.s0,
    admin = mongos.getDB( "admin" ),
    shards = mongos.getCollection( "config.shards" ).find().toArray(),
    coll = mongos.getCollection( "foo.bar" ),
    shard0Coll = st.shard0.getCollection( coll + "" ),
    shard1Coll = st.shard1.getCollection( coll + "" );

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
// Start a moveChunk in the background. Move chunk [0, 50) from shard 0 to
// shard 1. Pause it at each point in the donor's and recipient's work flows,
// and test cleanupOrphaned on shard 0 and shard 1.
//

pauseMoveChunkAtStep( st.shard0, 1 );
var joinMoveChunk = moveChunkParallel(
    staticMongod,
    st.s0.host,
    { _id : 0 },
    coll.getFullName(),
    shards[1]._id);

waitForMoveChunkStep( mongos, 1 );
// Donor has reloaded shard view.

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

proceedToMoveChunkStep( st.shard0, 2 );
// Donor has updated chunks view and got distributed lock.

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

pauseMigrateAtStep( st.shard1, 1 );
proceedToMoveChunkStep( st.shard0, 3 );
// Recipient has run _recvChunkStart and begun its migration thread; docs are
// being cloned and chunk [0, 50) is noted as "pending" on recipient.

proceedToMigrateStep( st.shard1, 2 );
proceedToMigrateStep( st.shard1, 3 );
proceedToMigrateStep( st.shard1, 4 );
// Recipient is waiting for donor to call _recvChunkCommit.

// Donor watches recipient's progress with _recvChunkStatus, finally calls
// _recvChunkCommit.
pauseMoveChunkAtStep( st.shard0, 6 );
unpauseMoveChunkAtStep( st.shard0, 3 );
proceedToMigrateStep( st.shard1, 5 );

// Create orphans.
shard0Coll.insert([{ _id: 51 }]);
assert.eq( null, shard0Coll.getDB().getLastError() );
assert.eq( 101, shard0Coll.count() );
shard1Coll.insert([{ _id: -1 }]);
assert.eq( null, shard1Coll.getDB().getLastError() );
assert.eq( 101, shard1Coll.count() );

// cleanupOrphaned removes migrated data from donor, which donor would
// otherwise clean up itself, in post-move delete phase (step 6).
cleanupOrphaned( st.shard0, coll + "", 2 );
assert.eq( 50, shard0Coll.count() );
cleanupOrphaned( st.shard1, coll + "", 2 );
assert.eq( 100, shard1Coll.count() );

// Let migration thread complete.
unpauseMigrateAtStep( st.shard1, 5 );
waitForMoveChunkStep( st.shard0, 6 );
// Donor has done post-move delete.

unpauseMoveChunkAtStep( st.shard0, 6 );
joinMoveChunk();
// Donor has returned from moveChunk command.

jsTest.log( "DONE!" );
st.stop();
