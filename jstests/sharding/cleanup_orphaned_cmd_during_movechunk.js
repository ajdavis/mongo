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
    donor = st.shard0,
    recipient = st.shard1,
    donorColl = donor.getCollection( coll + "" ),
    recipientColl = st.shard1.getCollection( coll + "" );

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
assert.eq( 100, donorColl.count() );

jsTest.log( "Inserting 50 docs into shard 1...." );
for ( i = 50; i < 100; i++ ) coll.insert({ _id : i });
assert.eq( null, coll.getDB().getLastError() );
assert.eq( 50, recipientColl.count() );

//
// Start a moveChunk in the background. Move chunk [0, 50) from shard 0 to
// shard 1. Pause it at some points in the donor's and recipient's work flows,
// and test cleanupOrphaned on shard 0 and shard 1.
//

jsTest.log( 'setting failpoint startedMoveChunk' );
pauseMoveChunkAtStep( donor, moveChunkStepNames.startedMoveChunk );
pauseMigrateAtStep( recipient, migrateStepNames.cloned );
var joinMoveChunk = moveChunkParallel(
    staticMongod,
    st.s0.host,
    { _id : 0 },
    coll.getFullName(),
    shards[1]._id);

jsTest.log( 'waiting for startedMoveChunk' );
waitForMoveChunkStep( donor, moveChunkStepNames.startedMoveChunk );
jsTest.log( 'waiting for cloned' );
waitForMigrateStep( recipient, migrateStepNames.cloned );
jsTest.log( 'done waiting for cloned' );
// Recipient has run _recvChunkStart and begun its migration thread; docs have
// been cloned and chunk [0, 50) is noted as "pending" on recipient.

// Create orphans.
donorColl.insert([{ _id: 51 }]);
assert.eq( null, donorColl.getDB().getLastError() );
assert.eq( 101, donorColl.count() );
recipientColl.insert([{ _id: -1 }]);
assert.eq( null, recipientColl.getDB().getLastError() );
assert.eq( 101, recipientColl.count() );

cleanupOrphaned( donor, coll + "", 2 );
assert.eq( 100, donorColl.count() );
cleanupOrphaned( recipient, coll + "", 2 );
assert.eq( 100, recipientColl.count() );

proceedToMigrateStep( recipient, migrateStepNames.transferredMods );
// Recipient is waiting for donor to call _recvChunkCommit.

// Create orphans.
donorColl.insert([{ _id: 51 }]);
assert.eq( null, donorColl.getDB().getLastError() );
assert.eq( 101, donorColl.count() );
recipientColl.insert([{ _id: -1 }]);
assert.eq( null, recipientColl.getDB().getLastError() );
assert.eq( 101, recipientColl.count() );

cleanupOrphaned( donor, coll + "", 2 );
assert.eq( 100, donorColl.count() );
cleanupOrphaned( recipient, coll + "", 2 );
assert.eq( 100, recipientColl.count() );

// Donor calls _recvChunkCommit.
pauseMoveChunkAtStep( donor, moveChunkStepNames.committed );
unpauseMoveChunkAtStep( donor, moveChunkStepNames.startedMoveChunk );
unpauseMigrateAtStep( recipient, migrateStepNames.transferredMods );
proceedToMigrateStep( recipient, migrateStepNames.done );

// Create orphans.
donorColl.insert([{ _id: 51 }]);
assert.eq( null, donorColl.getDB().getLastError() );
assert.eq( 101, donorColl.count() );
recipientColl.insert([{ _id: -1 }]);
assert.eq( null, recipientColl.getDB().getLastError() );
assert.eq( 101, recipientColl.count() );

// cleanupOrphaned removes migrated data from donor. The donor would
// otherwise clean them up itself in post-move delete phase.
cleanupOrphaned( donor, coll + "", 2 );
assert.eq( 50, donorColl.count() );
cleanupOrphaned( recipient, coll + "", 2 );
assert.eq( 100, recipientColl.count() );

// Let migration thread complete.
unpauseMigrateAtStep( recipient, migrateStepNames.done );
unpauseMoveChunkAtStep( donor, moveChunkStepNames.committed );
joinMoveChunk();
// Donor has done post-move delete.

jsTest.log( "DONE!" );
st.stop();
