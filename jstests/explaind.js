// Test cases for explain()'s index spec, SERVER-8688

var t = db.jstests_explaind;
t.drop();

// Regular indexes
t.ensureIndex({a: 1});
t.ensureIndex({b: -1});

var explain = t.find({a: 'foo', b: 'bar'}).explain(true);
assert.eq({a: 1}, explain.key);
assert.eq(3, explain.allPlans.length);

explain.allPlans.forEach(function(plan) {
    switch (plan.cursor) {
        case "BtreeCursor a_1":  assert.eq({a: 1}, plan.key);   break;
        case "BtreeCursor b_-1": assert.eq({b: -1}, plan.key);  break;
        case "BasicCursor":      assert.eq({}, plan.key);       break;
        default:
            throw "Unexpected cursor " + plan.cursor;
    }
});

// Chosen plan's key is included, even without 'verbose'
explain = t.find({a: 'foo'}).explain();
assert.eq({a: 1}, explain.key);

// Geo
t.drop();
t.createIndex({loc: '2d'});
explain = t.find({loc: {$within: {$centerSphere: [[0, 0], 1]}}}).explain(true);
assert.eq({loc: '2d'}, explain.key);
assert.eq(1, explain.allPlans.length);
assert.eq({loc: '2d'}, explain.allPlans[0].key);

