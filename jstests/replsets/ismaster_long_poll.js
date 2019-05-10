// Tests isMaster long-polling with awaitStatusChangeMillis.

(function() {
    'use strict';
    load('jstests/libs/check_log.js');

    const rst = new ReplSetTest({nodes: 2});
    // Ensure 'Received isMaster command with awaitStatusChangeMillis' is logged.
    rst.startSet({setParameter: {logComponentVerbosity: tojson({replication: 2})}});
    const nodeZero = rst.nodes[0];

    const pollNodeZero = () => {
        assert.commandWorked(nodeZero.adminCommand({clearLog: 'global'}));
        const pid = startParallelShellPid(() => {
            const reply = db.adminCommand({isMaster: 1, awaitStatusChangeMillis: 999999});
            print(`parallel shell got reply ${tojson(reply)}`);
            return assert.commandWorked(reply);
        }, nodeZero.port);

        checkLog.contains(
            nodeZero,
            'Received isMaster command with awaitStatusChangeMillis, waiting for state change');

        return {
            assertDone: (done) => {
                if (done) {
                    assert.eq(0, waitProgram(pid), 'encountered an error in the parallel shell');
                } else {
                    assert(checkProgram(pid).alive, 'parallel shell should not have exited yet');
                }
            }
        };
    };

    jsTestLog('start polling isMaster before replSetInitiate');

    let poller = pollNodeZero();
    poller.assertDone(false);
    rst.initiate();
    poller.assertDone(true);

    jsTestLog('start polling isMaster before replSetStepDown');

    poller = pollNodeZero();
    poller.assertDone(false);
    assert.commandWorked(rst.getPrimary().adminCommand({replSetStepDown: 60}));
    poller.assertDone(true);

    jsTestLog('await new primary');

    rst.getPrimary();

    jsTestLog('poll for one second, with no status change');

    const startTime = new Date().getTime() / 1000;
    const reply =
        assert.commandWorked(nodeZero.adminCommand({isMaster: 1, awaitStatusChangeMillis: 1000}));
    const endTime = new Date().getTime() / 1000;
    const duration = endTime - startTime;
    print(`Got isMaster reply ${tojson(reply)}`);
    assert.gte(duration, 1, `isMaster should have waited 1 sec, took ${duration}`);
    assert.gte(reply.awaitedTimeMillis, 1000);

    rst.stopSet();

})();
