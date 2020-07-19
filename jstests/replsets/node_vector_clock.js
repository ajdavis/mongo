(function() {
"use strict";

for (let useBridge of [false, true]) {
    jsTestLog(`Test replica set with useBridge: ${useBridge}`);
    const replTest = new ReplSetTest({name: jsTestName(), nodes: 2, useBridge: useBridge});
    const nodes = replTest.startSet();
    replTest.initiate();

    const reply = assert.commandWorked(replTest.getPrimary().adminCommand({ping: 1}));
    jsTestLog(`Ping reply: ${tojson(reply)}`);
    assert(reply.hasOwnProperty('nodeVectorClockForTest'));
    const nodeVectorClock = reply.nodeVectorClockForTest;
    for (let node of nodes) {
        assert(nodeVectorClock.hasOwnProperty(node.host), `host ${node.host} not in vector clock`);
    }

    replTest.stopSet();
}
}());
