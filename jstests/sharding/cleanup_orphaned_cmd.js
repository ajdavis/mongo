//
// Tests cleanup of orphaned data via the orphaned data cleanup command
//

load( './jstests/libs/cleanup_orphaned_util.js' );

var cleanupOrphanedTestSpecs = [
    {
        name: 'Shard on _id',
        shardKey: { _id: 1 },
        keyGen: function() {
            var ids = [];
            for ( var i = -50; i < 50; i++ ) { ids.push({ _id: i }); }
            return ids;
        }
    },
    {
        name: 'Compound shard key',
        shardKey: { a: 1, b: 1 },
        keyGen: function() {
            var ids = [];
            for ( var i = -50; i < 50; i++ ) {
                ids.push({ a: i, b: Math.random() });
            }

            return ids;
        }
    },
//    {
//        name: 'Hashed shard key',
//        shardKey: { a: 'hashed' },
//        keyGen: function() {
//            var ids = [];
//            for ( var i = -50; i < 50; i++ ) {
//                ids.push({ a: i });
//            }
//
//            return ids;
//        }
//    }
];

for ( var i = 0; i < cleanupOrphanedTestSpecs.length; i++ ) {
    testCleanupOrphaned( cleanupOrphanedTestSpecs[i] );
}