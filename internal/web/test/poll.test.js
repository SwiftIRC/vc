import { test } from "node:test";
import assert from "node:assert/strict";
import { tallyPercents, totalVotes } from "../assets/lib/poll.js";

test("no votes yields all zeros, not NaN", () => {
  assert.deepEqual(tallyPercents([0, 0, 0]), [0, 0, 0]);
  assert.equal(totalVotes([0, 0, 0]), 0);
});

test("a single vote is 100%", () => {
  assert.deepEqual(tallyPercents([1, 0]), [100, 0]);
});

test("an even split is exact", () => {
  assert.deepEqual(tallyPercents([2, 2]), [50, 50]);
});

// Naive rounding gives 33+33+33=99 and a bar row that never fills the card.
test("a three-way tie still sums to 100", () => {
  const p = tallyPercents([1, 1, 1]);
  assert.equal(p.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(p, [34, 33, 33], "the spare point goes to the earliest option");
});

test("percentages always sum to 100 whenever a vote exists", () => {
  for (const tallies of [[1, 2], [1, 1, 1], [5, 3, 1], [1, 1, 1, 1, 1, 1], [7, 0, 0, 2], [1, 2, 3, 4, 5, 6]]) {
    const p = tallyPercents(tallies);
    assert.equal(p.reduce((a, b) => a + b, 0), 100, `failed for ${JSON.stringify(tallies)}`);
    assert.equal(p.length, tallies.length);
  }
});

test("totalVotes sums the tallies", () => {
  assert.equal(totalVotes([1, 2, 3]), 6);
});

test("junk input does not throw", () => {
  assert.deepEqual(tallyPercents(null), []);
  assert.deepEqual(tallyPercents(undefined), []);
  assert.equal(totalVotes(null), 0);
  assert.deepEqual(tallyPercents(["2", null, undefined]), [100, 0, 0]);
});
