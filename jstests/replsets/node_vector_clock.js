(function() {
"use strict";

// TODO: try useBridge: true
const replTest = new ReplSetTest({name: jsTestName(), nodes: 2});
replTest.startSet();
replTest.initiate();

const reply = assert.commandWorked(replTest.getPrimary().adminCommand({ping: 1}));
jsTestLog(`Reply: ${tojson(reply)}`);
assert(reply.hasOwnProperty('nodeVectorClockForTest'));

replTest.stopSet();
}());
