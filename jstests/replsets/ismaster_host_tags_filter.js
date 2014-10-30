var BadValue = 2;

var replTest = new ReplSetTest({nodes: 5});
var conns = replTest.startSet();
var config = replTest.getReplSetConfig();

config.members[0].tags = {dc: 'ny', purpose: 'frontend'};

config.members[1].tags = {dc: 'sf', purpose: 'frontend'};
config.members[2].tags = {dc: 'sf', purpose: 'analytics'};

config.members[3].tags = {dc: 'chi', purpose: 'frontend'};
config.members[4].tags = {dc: 'chi', purpose: 'analytics'};

var admin = conns[0].getDB("admin");
jsTestLog('replSetInitiate');
var response = admin.runCommand({replSetInitiate: config});
printjson(response);
assert.commandWorked(response);

var primary = replTest.getPrimary();
jsTestLog("Primary " + tojson(primary));

var badTags = [
    // Not an array.
    1,
    // Object instead of array.
    {a: 'b'},
    // Tag values must be strings.
    [{a: 1}],
    // Empty tags.
    []
];

for (var i = 0; i < badTags.length; i++) {
    response = admin.runCommand({ismaster: 1, tags: badTags[i]});
    assert.commandFailed(response);
    assert.eq(BadValue, response.code);
}

var tagsAndHosts = [
    {tags: [{dc: 'ny'}],                            hosts: [0]},
    {tags: [{dc: 'sf'}],                            hosts: [0, 1, 2]},
    {tags: [{dc: 'chi'}],                           hosts: [0, 3, 4]},
    {tags: [{purpose: 'frontend'}],                 hosts: [0, 1, 3]},
    {tags: [{dc: 'sf'}, {purpose: 'frontend'}],     hosts: [0, 1, 2, 3]},
    {tags: [{dc: 'sf', purpose: 'frontend'}],       hosts: [0, 1]},
    {tags: [{}],                                    hosts: [0, 1, 2, 3, 4]},
    {tags: [{dc: 'ny'}, {}],                        hosts: [0, 1, 2, 3, 4]},

    // A tag set with no matches is OR'ed with a tag set that has matches.
    {tags: [{dc: 'sf'}, {dc: 'whatever'}],          hosts: [0, 1, 2]},
    {tags: [{dc: 'whatever'}, {dc: 'sf'}],          hosts: [0, 1, 2]},
    {tags: [{dc: 'sf'}, {doesntexist: 'foo'}],      hosts: [0, 1, 2]},

    // The primary is always included.
    {tags: [{dc: 'whatever'}],                      hosts: [0]},
    {tags: [{doesntexist: 'foo'}],                  hosts: [0]}
];

for (i = 0; i < tagsAndHosts.length; i++) {
    var hostTagsFilter = tagsAndHosts[i].tags;
    var hosts = tagsAndHosts[i].hosts;
    response = admin.runCommand({ismaster: 1, tags: hostTagsFilter});
    assert.commandWorked(response);
    assert.eq(
        hosts.length, response.hosts.length,
        "Expected " + tojson(hostTagsFilter) + " to match hosts");

    for (var j = 0; j < hosts.length; j++) {
        var hostId = hosts[j];
        var hostAndPort = config.members[hostId].host;
        assert.contains(
            hostAndPort, response.hosts,
            "Expected " + hostAndPort
            + " with tags " + tojson(config.members[j].tags)
            + " to match " + tojson(hostTagsFilter));
    }
}
