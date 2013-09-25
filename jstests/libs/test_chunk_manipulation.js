//
// Utilities for testing chunk manipulation: moveChunk, mergeChunks, etc.
//

load( './jstests/libs/test_background_ops.js' );

//
// Start a background moveChunk.
// mongosURL:      Like 'localhost:27017'.
// findCriteria:   Like { _id: 1 }, passed to moveChunk's "find" option.
// ns:             Like 'dbName.collectionName'
// toShardId:      Like 'shard0001'.
//
// Returns a join function; call it to wait for moveChunk to complete.
// 
function moveChunkParallel( mongosURL, findCriteria, ns, toShardId ) {
    function runMoveChunk( mongosURL, findCriteria, ns, toShardId ) {
        var mongos = new Mongo( mongosURL ),
            admin = mongos.getDB( 'admin' );

        assert( admin.runCommand({ moveChunk : ns,
                                   find : findCriteria,
                                   to : toShardId,
                                   _waitForDelete : true }).ok );
    }

    var joinMoveChunk = startParallelOps(
        staticMongod, runMoveChunk,
        [ mongosURL, findCriteria, ns, toShardId ] );

    return joinMoveChunk;
}

//
// Configure a failpoint to make moveChunk hang at a step (1 through 6).
//
function pauseMoveChunkAtStep( shardConnection, stepNumber ) {
    configureMoveChunkFailPoint( shardConnection, stepNumber, 'alwaysOn' );
}

//
// Allow moveChunk to proceed past a step.
//
function unpauseMoveChunkAtStep( shardConnection, stepNumber ) {
    configureMoveChunkFailPoint( shardConnection, stepNumber, 'off' );
}

function configureMoveChunkFailPoint( shardConnection, stepNumber, mode ) {
    assert( stepNumber >= 1);
    assert( stepNumber <= 6 );
    var admin = shardConnection.getDB( 'admin' );
    admin.runCommand({ configureFailPoint: 'moveChunkHangAtStep' + stepNumber,
                       mode: mode });
}

//
// Wait for moveChunk to reach a step (1 through 6). Assumes only one moveChunk
// is in mongos's currentOp.
//
function waitForMoveChunkStep( mongosConnection, stepNumber ) {
    var searchString = 'step ' + stepNumber,
        admin = mongosConnection.getDB( 'admin' );

    assert( stepNumber >= 1);
    assert( stepNumber <= 6 );

    assert.soon( function() {
        var in_progress = admin.currentOp().inprog;
        for ( var i = 0; i < in_progress.length; ++i ) {
            var op = in_progress[i];
            if ( op.query && op.query.moveChunk ) { return op; }
        }

        return op && op.msg && op.msg.startsWith( searchString );
    });
}
