// Fill a device <select> from an enumerateDevices() list. Shared by the lobby
// (ui/prejoin.js) and the in-call control bar (ui/controls.js), which offer the same
// Camera / Microphone / Speaker pickers in different chrome and previously each kept
// their own near-identical copy of this.
//
// activeId is the deviceId to mark selected. For an INPUT that is the live track's
// device (see trackDeviceId); for an OUTPUT there is no track to read a sink from, so
// it is the persisted choice. "" marks nothing, which leaves the browser showing the
// first option — so a caller acting on the selection should read select.value rather
// than assume activeId is what the user sees.
//
// label ("Camera" / "Microphone" / "Speaker") supplies both the empty-list message and
// the fallback names: enumerateDevices only populates real labels once permission has
// been granted, so an unnamed device still gets "Camera 1" rather than a blank row.
//
// Sets select.disabled — true when there is nothing to choose, false otherwise. A
// caller with a companion control (the lobby's speaker Test button) should follow
// select.disabled rather than re-deriving emptiness.
export function fillDeviceSelect(select, list, activeId, label) {
  select.replaceChildren();
  if (list.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = `No ${label.toLowerCase()} found`;
    select.append(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  list.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${label} ${i + 1}`;
    if (d.deviceId && d.deviceId === activeId) opt.selected = true;
    select.append(opt);
  });
}

// The deviceId a live track is currently using, or "" when there is no track (the
// camera is off, or the device failed to open). Pass the result as fillDeviceSelect's
// activeId for an input picker.
export function trackDeviceId(track) {
  return track ? track.getSettings().deviceId : "";
}
