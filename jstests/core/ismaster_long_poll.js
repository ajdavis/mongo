// Tests isMaster long-polling with awaitStatusChangeMillis.

(function() {
    'use strict';

    const startTime = new Date().getTime() / 1000;
    const reply =
        assert.commandWorked(db.adminCommand({isMaster: 1, awaitStatusChangeMillis: 1000}));
    const endTime = new Date().getTime() / 1000;
    const duration = endTime - startTime;
    print(`Got isMaster reply ${tojson(reply)}`);
    assert.gte(duration, 1, `isMaster should have waited 1 sec, took ${duration}`);
    assert.gte(reply.awaitedTimeMillis, 1000);
})();
