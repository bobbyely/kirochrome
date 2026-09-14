// `nextClockRun` uses local `setHours`/`setDate`, so a daily schedule has to
// survive the two nights a year when the local clock skips or repeats an
// hour. Its own file, because it pins TZ for the whole process.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// London: clocks go forward 29 Mar 2026 (01:00 → 02:00) and back 25 Oct 2026
// (02:00 → 01:00). Node re-reads TZ when process.env.TZ is assigned.
process.env.TZ = "Europe/London";
const { nextClockRun } = await import("../dist/scheduler.js");

const local = (y, m, d, h, min) => new Date(y, m, d, h, min).getTime();
const day = (t) => new Date(t).toDateString();

describe("a clock schedule across DST", () => {
  it("fires once a day through the spring-forward night, including the time that does not exist", () => {
    let last = local(2026, 2, 27, 1, 30); // Fri 27 Mar, 01:30 GMT
    const days = [];
    for (let i = 0; i < 4; i++) {
      const next = nextClockRun("01:30", false, last);
      assert.ok(next > last, "always later than the last run");
      days.push(day(next));
      last = next;
    }
    assert.deepEqual(days, ["Sat Mar 28 2026", "Sun Mar 29 2026", "Mon Mar 30 2026", "Tue Mar 31 2026"], "one run per calendar day, none skipped or doubled");
    // 01:30 does not exist on the 29th; the run lands within the hour after.
    const skipped = new Date(nextClockRun("01:30", false, local(2026, 2, 28, 1, 30)));
    assert.ok(skipped.getHours() <= 2 && skipped.getMinutes() === 30, `lands near the time on the skipped night, got ${skipped}`);
  });

  it("fires once a day through the fall-back night, when 01:30 happens twice", () => {
    let last = local(2026, 9, 23, 1, 30); // Fri 23 Oct, 01:30 BST
    const days = [];
    for (let i = 0; i < 4; i++) {
      const next = nextClockRun("01:30", false, last);
      assert.ok(next > last);
      days.push(day(next));
      last = next;
    }
    assert.deepEqual(days, ["Sat Oct 24 2026", "Sun Oct 25 2026", "Mon Oct 26 2026", "Tue Oct 27 2026"]);
  });
});
