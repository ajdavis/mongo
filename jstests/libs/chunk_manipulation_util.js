//
// Utilities for testing chunk manipulation: moveChunk, mergeChunks, etc.
//

load( './jstests/libs/test_background_ops.js' );

//
// Start a background moveChunk.
// staticMongod:   Server to use for communication, use
//                 "MongoRunner.runMongod({})" to make one.
// mongosURL:      Like 'localhost:27017'.
// findCriteria:   Like { _id: 1 }, passed to moveChunk's "find" option.
// ns:             Like 'dbName.collectionName'.
// toShardId:      Like 'shard0001'.
//
// Returns a join function; call it to wait for moveChunk to complete.
// 
function moveChunkParallel( staticMongod, mongosURL, findCriteria, ns, toShardId ) {
    function runMoveChunk( mongosURL, findCriteria, ns, toShardId ) {
        var mongos = new Mongo( mongosURL ),
            admin = mongos.getDB( 'admin' ),
            result = admin.runCommand({ moveChunk : ns,
                                        find : findCriteria,
                                        to : toShardId,
                                        _waitForDelete : true });

        printjson( result );
        assert( result.ok );
    }

    // Return the join function.
    return startParallelOps(
        staticMongod, runMoveChunk,
        [ mongosURL, findCriteria, ns, toShardId ] );
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

function proceedToMoveChunkStep( shardConnection, stepNumber ) {
    jsTest.log( "moveChunk proceeding from step " + (stepNumber - 1)
                + " to " + stepNumber );

    pauseMoveChunkAtStep( shardConnection, stepNumber );
    unpauseMoveChunkAtStep( shardConnection, stepNumber - 1 );
    waitForMoveChunkStep( shardConnection, stepNumber );
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
function waitForMoveChunkStep( shardConnection, stepNumber ) {
    var searchString = 'step ' + stepNumber,
        admin = shardConnection.getDB( 'admin' );

    assert( stepNumber >= 1);
    assert( stepNumber <= 6 );

    assert.soon( function() {
        var in_progress = admin.currentOp().inprog;
        for ( var i = 0; i < in_progress.length; ++i ) {
            var op = in_progress[i];
            if ( op.query && op.query.moveChunk ) {
                return op.msg.startsWith( searchString );
            }
        }

        return false;
    });
}

//
// Configure a failpoint to make migration thread hang at a step (1 through 5).
//
function pauseMigrateAtStep( shardConnection, stepNumber ) {
    configureMigrateFailPoint( shardConnection, stepNumber, 'alwaysOn' );
}

//
// Allow _recvChunkStart to proceed past a step.
//
function unpauseMigrateAtStep( shardConnection, stepNumber ) {
    configureMigrateFailPoint( shardConnection, stepNumber, 'off' );
}

function proceedToMigrateStep( shardConnection, stepNumber ) {
    jsTest.log( "Migration thread proceeding from step " + (stepNumber - 1)
                + " to " + stepNumber );

    pauseMigrateAtStep( shardConnection, stepNumber );
    unpauseMigrateAtStep( shardConnection, stepNumber - 1 );
    waitForMigrateStep( shardConnection, stepNumber );
}

function configureMigrateFailPoint( shardConnection, stepNumber, mode ) {
    assert( stepNumber >= 1);
    assert( stepNumber <= 5 );
    var admin = shardConnection.getDB( 'admin' );
    admin.runCommand({ configureFailPoint: 'migrateThreadHangAtStep' + stepNumber,
                       mode: mode });
}

//
// Wait for moveChunk to reach a step (1 through 6). Assumes only one moveChunk
// is in mongos's currentOp.
//
function waitForMigrateStep( shardConnection, stepNumber ) {
    var searchString = 'step ' + stepNumber,
        admin = shardConnection.getDB( 'admin' );

    assert( stepNumber >= 1);
    assert( stepNumber <= 5 );

    assert.soon( function() {
        // verbose = True so we see the migration thread.
        var in_progress = admin.currentOp(true).inprog;
        for ( var i = 0; i < in_progress.length; ++i ) {
            var op = in_progress[i];
            if ( op.desc && op.desc === 'migrateThread' ) {
                return op.msg.startsWith( searchString );
            }
        }

        return false;
    });
}
