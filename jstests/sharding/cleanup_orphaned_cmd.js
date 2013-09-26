//
// Tests cleanup of orphaned data via the orphaned data cleanup command
//

load( './jstests/libs/cleanup_orphaned_util.js' );

var cleanupOrphanedTestSpecs = [
    {
        shardKey: {_id: 1 },
        keyGen: function() {
            var ids = [];
            for ( var i = -50; i < 50; i++ ) { ids.push({ _id: i }); }
            return ids;
        }
    }
];

for ( var i = 0; i < cleanupOrphanedTestSpecs.length; i++ ) {
    testCleanupOrphaned( cleanupOrphanedTestSpecs[i] );
}