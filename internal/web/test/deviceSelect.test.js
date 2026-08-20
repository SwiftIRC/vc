import { test } from "node:test";
import assert from "node:assert/strict";
import { fillDeviceSelect, trackDeviceId } from "../assets/lib/deviceSelect.js";

// Node has no DOM. fillDeviceSelect's only DOM dependency is
// document.createElement("option"), so stub just that — no jsdom, no harness.
// Each stubbed <option> is a plain mutable object; that's all fillDeviceSelect
// touches (value / textContent / selected) before handing it to select.append().
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, "option", "fillDeviceSelect should only ever create <option> elements");
    return { value: "", textContent: "", selected: false };
  },
};

// A stand-in <select>: just enough of the real element for fillDeviceSelect to
// drive — replaceChildren() to clear, append() to add, and a disabled property.
function fakeSelect() {
  const options = [];
  return {
    disabled: false,
    replaceChildren() {
      options.length = 0;
    },
    append(opt) {
      options.push(opt);
    },
    options,
  };
}

test("an empty list disables the select and shows a single 'not found' option", () => {
  const select = fakeSelect();
  fillDeviceSelect(select, [], "", "Speaker");
  assert.equal(select.disabled, true);
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, "");
  assert.equal(select.options[0].textContent, "No speaker found");
});

test("a non-empty list enables the select and appends one option per device, using real labels", () => {
  const select = fakeSelect();
  const list = [
    { deviceId: "a1", label: "Built-in Speakers" },
    { deviceId: "a2", label: "USB Headset" },
  ];
  fillDeviceSelect(select, list, "", "Speaker");
  assert.equal(select.disabled, false);
  assert.equal(select.options.length, 2);
  assert.equal(select.options[0].textContent, "Built-in Speakers");
  assert.equal(select.options[1].textContent, "USB Headset");
});

test("a blank label falls back to '<label> <1-based index>'", () => {
  const select = fakeSelect();
  const list = [
    { deviceId: "c1", label: "" },
    { deviceId: "c2", label: "" },
  ];
  fillDeviceSelect(select, list, "", "Camera");
  assert.equal(select.options[0].textContent, "Camera 1");
  assert.equal(select.options[1].textContent, "Camera 2");
});

test("a device whose deviceId is '' is never marked selected, even when activeId is also ''", () => {
  const select = fakeSelect();
  const list = [{ deviceId: "", label: "Default Microphone" }];
  fillDeviceSelect(select, list, "", "Microphone");
  assert.equal(select.options[0].selected, false);
});

test("a device is marked selected when its deviceId matches a non-empty activeId", () => {
  const select = fakeSelect();
  const list = [
    { deviceId: "m1", label: "Mic One" },
    { deviceId: "m2", label: "Mic Two" },
  ];
  fillDeviceSelect(select, list, "m2", "Microphone");
  assert.equal(select.options[0].selected, false);
  assert.equal(select.options[1].selected, true);
});

test("trackDeviceId is '' when there is no track", () => {
  assert.equal(trackDeviceId(null), "");
  assert.equal(trackDeviceId(undefined), "");
});

test("trackDeviceId reads deviceId off the track's current settings", () => {
  const track = { getSettings: () => ({ deviceId: "xyz-789" }) };
  assert.equal(trackDeviceId(track), "xyz-789");
});
