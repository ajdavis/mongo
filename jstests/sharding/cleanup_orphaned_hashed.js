//
// Test cleanupOrphaned with a hashed shard key.
//

load('./jstests/libs/cleanup_orphaned_util.js');

testCleanupOrphaned({
    shardKey: {a: 'hashed'},
    keyGen: function() {
        var ids = [];
        for (var i = -50; i < 50; i++) {
            ids.push({a: i});
        }

        return ids;
    }
});
