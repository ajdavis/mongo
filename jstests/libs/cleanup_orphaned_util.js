//
// Utilities for testing cleanupOrphaned command.
//

//
// Run the cleanupOrphaned command on a shard. If expectedIterations is passed,
// assert cleanupOrphaned runs the expected number of times before stopping.
//
function cleanupOrphaned( shardConnection, ns, expectedIterations ) {
    var admin = shardConnection.getDB('admin' ),
        result = admin.runCommand({ cleanupOrphaned: ns } ),
        iterations = 0;

    assert( result.ok );
    while ( result.stoppedAtKey ) {
        if ( expectedIterations !== undefined ) {
            assert( ++iterations < expectedIterations );
        }

        result = admin.runCommand({ cleanupOrphaned : ns,
                                    startingFromKey : result.stoppedAtKey });

        assert( result.ok );
    }
}

// TODO: doc
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
        ids = options.idGenerator(),
        beginning = ids[0],
        oneQuarter = ids[Math.round(ids.length / 4)],
        middle = ids[Math.round(ids.length / 2)],
        threeQuarters = ids[Math.round(3 * ids.length / 4)],
        result;

    assert( admin.runCommand({ enableSharding : coll.getDB().getName() }).ok );
    printjson( admin.runCommand({ movePrimary : coll.getDB().getName(), to : shards[0]._id }) );
    assert( admin.runCommand({ shardCollection : coll.getFullName(), key : options.shardKey }).ok );
    st.printShardingStatus();

    jsTest.log( "Inserting some regular docs..." );

    for ( var i = 0; i < ids.length; i++ ) coll.insert({ _id : ids[i] });
    assert.eq( null, coll.getDB().getLastError() );

    assert( admin.runCommand(
        {
            split : coll.getFullName(),
            middle: { _id: middle }
        } ).ok );

    assert( admin.runCommand(
        {
            moveChunk : coll.getFullName(),
            find : { _id: middle },
            to : shards[1]._id,
            _waitForDelete : true
        }).ok );

    // Half of the data is on each shard
    assert.eq( ids.length / 2, shard0Coll.count() );
    assert.eq( ids.length, coll.find().itcount() );

    jsTest.log( "Inserting some orphaned docs..." );

    shard0Coll.insert({ _id: afterMiddle });
    assert.eq( null, shard0Coll.getDB().getLastError() );
    assert.neq( ids.length / 2, shard0Coll.count() );

    jsTest.log( "Cleaning up orphaned data..." );

    cleanupOrphaned( st.shard0, coll.getFullName(), 2 );
    assert.eq( ids.length / 2, shard0Coll.count() );
    assert.eq( ids.length, coll.find().itcount() );

    jsTest.log( "Moving half the data out again (making a hole)..." );

    assert( admin.runCommand(
        {
            split : coll.getFullName(),
            middle : { _id : oneQuarter }
        }).ok );

    assert( admin.runCommand({ moveChunk : coll.getFullName(),
                               find : { _id : beginning },
                               to : shards[1]._id,
                               _waitForDelete : true }).ok );

    // 1/4 the data is on the first shard
    assert.eq( Math.round(ids.length / 4), shard0Coll.count() );
    assert.eq( 100, coll.find().itcount() );

    jsTest.log( "Inserting some more orphaned docs..." );

    shard0Coll.insert({ _id : oneQuarter });
    shard0Coll.insert({ _id : middle });
    assert.eq( null, shard0Coll.getDB().getLastError() );
    assert.neq( Math.round(ids.length / 4), shard0Coll.count() );
    assert.eq( 100, coll.find().itcount() );

    jsTest.log( "Cleaning up more orphaned data..." );

    // Now there are 3 regions, not 2.
    cleanupOrphaned( st.shard0, 3 );
    assert.eq( Math.round(ids.length / 4), shard0Coll.count() );
    assert.eq( 100, coll.find().itcount() );

    jsTest.log( "DONE!" );

    st.stop();
}
