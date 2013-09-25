//
// Tests cleanupOrphaned concurrent with moveChunk.
//

load( './jstests/libs/test_chunk_manipulation.js' );

var staticMongod = MongoRunner.runMongod({});  // For startParallelOps.
var options = { separateConfig : true, shardOptions : { verbose : 0 } };
var st = new ShardingTest({ shards : 2, mongos : 1, other : options });
st.stopBalancer();

var mongos = st.s0;
var admin = mongos.getDB( "admin" );
var shards = mongos.getCollection( "config.shards" ).find().toArray();
var coll = mongos.getCollection( "foo.bar" );

assert( admin.runCommand({ enableSharding : coll.getDB() + "" }).ok );
printjson( admin.runCommand({ movePrimary : coll.getDB() + "", to : shards[0]._id }) );
assert( admin.runCommand({ shardCollection : coll + "", key : { _id : 1 } }).ok );
assert( admin.runCommand({ split : coll + "", middle : { _id : 0 } }).ok );

jsTest.log( "Inserting 100 docs into shard 0...." );

for ( var i = -50; i < 50; i++ ) coll.insert({ _id : i });
assert.eq( null, coll.getDB().getLastError() );

var shard0Admin = st.shard0.getDB( "admin" );

//
// Start a moveChunk in the background; pause it at each point and try
// cleanupOrphaned on shard 0 and shard 1.
//

pauseMoveChunkAtStep( st.shard0, 1 );
var joinMoveChunk = moveChunkParallel( st.s0.host,
                                       { _id : 0 },
                                       coll.getFullName(),
                                       shards[1]._id );

for ( var stepNumber = 1; stepNumber < 6; stepNumber++ ) {
    waitForMoveChunkStep( mongos, stepNumber );
    jsTest.log( "moveChunk proceeding from step " + stepNumber
                + " to " + (stepNumber + 1));

    pauseMoveChunkAtStep( st.shard0, stepNumber + 1 );
    unpauseMoveChunkAtStep( st.shard0, stepNumber );
}

unpauseMoveChunkAtStep( st.shard0, 6 );

jsTest.log( "moveChunk completing" );

//
//// Half of the data is on each shard
//
//jsTest.log( "Inserting some orphaned docs..." );
//
//var shard0Coll = st.shard0.getCollection( coll + "" );
//shard0Coll.insert({ _id : 10 });
//assert.eq( null, shard0Coll.getDB().getLastError() );
//
//assert.neq( 50, shard0Coll.count() );
//assert.eq( 100, coll.find().itcount() );
//
//jsTest.log( "Cleaning up orphaned data..." );
//
//var result = shard0Admin.runCommand({ cleanupOrphaned : coll + "" });
//while ( result.ok && result.stoppedAtKey ) {
//    printjson( result );
//    result = shard0Admin.runCommand({ cleanupOrphaned : coll + "",
//                                      startingFromKey : result.stoppedAtKey });
//}
//
//printjson( result );
//assert( result.ok );
//assert.eq( 50, shard0Coll.count() );
//assert.eq( 100, coll.find().itcount() );
//
//jsTest.log( "Moving half the data out again (making a hole)..." );
//
//assert( admin.runCommand({ split : coll + "", middle : { _id : -35 } }).ok );
//assert( admin.runCommand({ split : coll + "", middle : { _id : -10 } }).ok );
//// Make sure we wait for the deletion here, otherwise later cleanup could fail
//assert( admin.runCommand({ moveChunk : coll + "",
//                           find : { _id : -35 },
//                           to : shards[1]._id,
//                           _waitForDelete : true }).ok );
//
//// 1/4 the data is on the first shard
//
//jsTest.log( "Inserting some more orphaned docs..." );
//
//var shard0Coll = st.shard0.getCollection( coll + "" );
//shard0Coll.insert({ _id : -36 });
//shard0Coll.insert({ _id : -10 });
//shard0Coll.insert({ _id : 0 });
//shard0Coll.insert({ _id : 10 });
//assert.eq( null, shard0Coll.getDB().getLastError() );
//
//assert.neq( 25, shard0Coll.count() );
//assert.eq( 100, coll.find().itcount() );
//
//jsTest.log( "Cleaning up more orphaned data..." );
//
//var shard0Admin = st.shard0.getDB( "admin" );
//var result = shard0Admin.runCommand({ cleanupOrphaned : coll + "" });
//while ( result.ok && result.stoppedAtKey ) {
//    printjson( result );
//    result = shard0Admin.runCommand({ cleanupOrphaned : coll + "",
//                                      startingFromKey : result.stoppedAtKey });
//}
//
//printjson( result );
//assert( result.ok );
//assert.eq( 25, shard0Coll.count() );
//assert.eq( 100, coll.find().itcount() );

joinMoveChunk();

//jsTest.log( "DONE!" );
//
//st.stop();
