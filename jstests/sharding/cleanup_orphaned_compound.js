//
// Test cleanupOrphaned with a compound shard key.
//

load('./jstests/libs/cleanup_orphaned_util.js');

testCleanupOrphaned({
    shardKey: {a: 1, b: 1},
    keyGen: function() {
        var ids = [];
        for (var i = -50; i < 50; i++) {
            ids.push({a: i, b: Math.random()});
        }

        return ids;
    }
});
