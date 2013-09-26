//
// Utilities for testing cleanupOrphaned command.
//

// Get the shard key in the middle of a collection.
function getMiddle( shardConnection, ns, keyPattern ) {
    var admin = shardConnection.getDB('admin' ),
        splitResult = admin.runCommand(
        {
            splitVector: ns,
            keyPattern: keyPattern,
            force: true
        });

    assert( splitResult.ok );
    assert.eq(1, splitResult.splitKeys.length);
    return splitResult.splitKeys[0];
}

function testCleanupOrphaned(options) {
    var st = new ShardingTest(
        {
            shards : 2,
            mongos : 2,
            other : { separateConfig : true, shardOptions : { verbose : 0 } }
        });

    st.stopBalancer();

    var mongos = st.s0,
        admin = mongos.getDB( "admin" ),
        shards = mongos.getCollection( "config.shards" ).find().toArray(),
        coll = mongos.getCollection( "foo.bar" ),
        shard0Coll = st.shard0.getCollection( coll.getFullName() ),
        shard0Admin = st.shard0.getDB( "admin" ),
        middle,
        result;

    assert( admin.runCommand({ enableSharding : coll.getDB().getName() }).ok );
    printjson( admin.runCommand({ movePrimary : coll.getDB().getName(), to : shards[0]._id }) );
    assert( admin.runCommand({ shardCollection : coll.getFullName(), key : options.shardKey }).ok );
    st.printShardingStatus();

    jsTest.log( "Inserting some regular docs..." );

    var ids = options.idGenerator();
    for ( var i = 0; i < ids.length; i++ ) coll.insert({ _id : ids[i] });
    assert.eq( null, coll.getDB().getLastError() );

    // Half of the data is on each shard
    middle = getMiddle( st.shard0, coll.getFullName(), options.shardKey );
    assert( admin.runCommand(
        {
            split : coll.getFullName(),
            middle: middle
        } ).ok );

    assert( admin.runCommand(
        {
            moveChunk : coll.getFullName(),
            find : middle,
            to : shards[1]._id,
            _waitForDelete : true
        }).ok );

    assert.eq( ids.length / 2, shard0Coll.count() );
    assert.eq( ids.length, coll.find().itcount() );

    jsTest.log( "Inserting some orphaned docs..." );

    shard0Coll.insert({ _id : 10 });
    assert.eq( null, shard0Coll.getDB().getLastError() );

    jsTest.log( "Cleaning up orphaned data..." );

    result = shard0Admin.runCommand({ cleanupOrphaned : coll.getFullName() });

    // TODO: use function
    while ( result.ok && result.stoppedAtKey ) {
        printjson( result );
        result = shard0Admin.runCommand({ cleanupOrphaned : coll.getFullName(),
                                          startingFromKey : result.stoppedAtKey });
    }

    printjson( result );
    assert( result.ok );
    assert.eq( 50, shard0Coll.count() );
    assert.eq( 100, coll.find().itcount() );

    jsTest.log( "Moving half the data out again (making a hole)..." );

    assert( admin.runCommand({ split : coll.getFullName(), middle : { _id : -35 } }).ok );
    assert( admin.runCommand({ split : coll.getFullName(), middle : { _id : -10 } }).ok );
    // Make sure we wait for the deletion here, otherwise later cleanup could fail
    assert( admin.runCommand({ moveChunk : coll.getFullName(),
                               find : { _id : -35 },
                               to : shards[1]._id,
                               _waitForDelete : true }).ok );

    // 1/4 the data is on the first shard

    jsTest.log( "Inserting some more orphaned docs..." );

    shard0Coll.insert({ _id : -36 });
    shard0Coll.insert({ _id : -10 });
    shard0Coll.insert({ _id : 0 });
    shard0Coll.insert({ _id : 10 });
    assert.eq( null, shard0Coll.getDB().getLastError() );

    assert.neq( 25, shard0Coll.count() );
    assert.eq( 100, coll.find().itcount() );

    jsTest.log( "Cleaning up more orphaned data..." );

    result = shard0Admin.runCommand({ cleanupOrphaned : coll.getFullName() });
    while ( result.ok && result.stoppedAtKey ) {
        printjson( result );
        result = shard0Admin.runCommand({ cleanupOrphaned : coll.getFullName(),
                                          startingFromKey : result.stoppedAtKey });
    }

    printjson( result );
    assert( result.ok );
    assert.eq( 25, shard0Coll.count() );
    assert.eq( 100, coll.find().itcount() );

    jsTest.log( "DONE!" );

    st.stop();
}
