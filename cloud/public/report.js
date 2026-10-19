export const MAX_IMAGES = 20;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export const MAX_EDGE = 2000;
export const JPEG_QUALITY = 0.85;
export const MAX_TITLE = 120;
export const MAX_DETAILS = 10000;
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const $ = (selector) => document.querySelector(selector);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...kids);
  return node;
};

export function fitSize(width, height, max = MAX_EDGE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function formatBytes(bytes) {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

export function checkDraft({ title, details, from, to }) {
  if (!title.trim()) return "Enter a title.";
  if (title.trim().length > MAX_TITLE) return `The title can be at most ${MAX_TITLE} characters.`;
  if (!details.trim()) return "Describe what went wrong in the details.";
  if (details.trim().length > MAX_DETAILS) return `The details can be at most ${MAX_DETAILS} characters.`;
  if (from && to && Date.parse(from) > Date.parse(to)) return "The start time is after the end time.";
  return null;
}

export async function compress(file) {
  if (!TYPES.includes(file.type)) throw new Error(`${file.name || "This file"} is not a png, jpeg, webp or gif image.`);
  let out = file;
  if (file.type !== "image/gif") {
    try {
      const bitmap = await createImageBitmap(file);
      const [sourceWidth, sourceHeight] = [bitmap.width, bitmap.height];
      const [width, height] = fitSize(sourceWidth, sourceHeight);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
      if (blob && (width !== sourceWidth || height !== sourceHeight || blob.size < file.size)) {
        out = new File([blob], `${(file.name || "image").replace(/\.[^.]*$/, "")}.jpg`, { type: "image/jpeg" });
      }
    } catch {
      out = file;
    }
  }
  if (out.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || "This image"} is still over ${MAX_IMAGE_BYTES / 1048576} MB after compression.`);
  return out;
}

export const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

export function initReport({ tokenFor, botCheckError }) {
  let openState = false;
  const modal = $("#reportModal");
  const form = $("#reportForm");
  const fields = { category: $("#rCategory"), title: $("#rTitle"), details: $("#rDetails"), from: $("#rFrom"), to: $("#rTo") };
  let items = [];
  let nextId = 1;
  let busy = false;
  let returnFocus = null;
  let appWasInert = false;
  let addWasInert = false;

  const showError = (message) => { $("#reportErr").textContent = message ?? ""; $("#reportErr").classList.toggle("d-none", !message); };
  const showImageNote = (message) => { $("#rImageNote").textContent = message ?? ""; $("#rImageNote").classList.toggle("d-none", !message); };
  const total = () => items.reduce((sum, item) => sum + item.file.size, 0);

  function renderImages() {
    $("#rImageCount").textContent = `${items.length} / ${MAX_IMAGES}`;
    $("#rPreviews").replaceChildren(...items.map((item, i) => {
      const remove = el("button", { type: "button", class: "btn btn-sm btn-dark position-absolute top-0 end-0 m-1 lh-1 p-1", "data-remove": item.id, "aria-label": `Remove image ${i + 1}` });
      remove.append(el("i", { class: "bi bi-x-lg" }));
      const frame = el("div", { class: "position-relative" }, el("div", { class: "ratio ratio-1x1" }, el("img", { src: item.url, alt: `Image ${i + 1}`, class: "object-fit-cover rounded border" })), remove);
      return el("div", { class: "col-4 col-sm-3", "data-image": item.id }, frame, el("div", { class: "small text-muted text-truncate" }, formatBytes(item.file.size)));
    }));
    $("#rDrop").classList.toggle("d-none", items.length >= MAX_IMAGES);
  }

  function dropItem(id) {
    const item = items.find((i) => i.id === id);
    if (item) URL.revokeObjectURL(item.url);
    items = items.filter((i) => i.id !== id);
    showImageNote(null);
    renderImages();
  }

  async function addFiles(list) {
    const files = [...list].filter((file) => file.type.startsWith("image/") || TYPES.includes(file.type));
    if (!files.length) return;
    const notes = [];
    $("#rPick").disabled = true;
    for (const file of files) {
      if (items.length >= MAX_IMAGES) { notes.push(`Only ${MAX_IMAGES} images can be attached.`); break; }
      try {
        const out = await compress(file);
        if (total() + out.size > MAX_TOTAL_BYTES) { notes.push(`${file.name || "An image"} would take the images over ${MAX_TOTAL_BYTES / 1048576} MB in total.`); continue; }
        items.push({ id: nextId++, file: out, url: URL.createObjectURL(out) });
        renderImages();
      } catch (err) {
        notes.push(err.message);
      }
    }
    $("#rPick").disabled = false;
    showImageNote(notes.join(" "));
  }

  function resetForm() {
    form.reset();
    items.forEach((item) => URL.revokeObjectURL(item.url));
    items = [];
    renderImages();
    showError(null);
    showImageNote(null);
    $("#rDetailsCount").textContent = "0";
  }

  function open() {
    if (openState) return;
    openState = true;
    returnFocus = document.activeElement;
    const app = $("#app");
    const add = $("#addModal");
    appWasInert = app.inert;
    addWasInert = add.inert;
    app.inert = true;
    add.inert = true;
    $("#reportForm").classList.remove("d-none");
    $("#reportDone").classList.add("d-none");
    modal.classList.add("d-block");
    modal.setAttribute("aria-hidden", "false");
    $("#reportBackdrop").classList.remove("d-none");
    fields.title.focus();
  }

  function close() {
    if (!openState || busy) return;
    openState = false;
    modal.classList.remove("d-block");
    modal.setAttribute("aria-hidden", "true");
    $("#reportBackdrop").classList.add("d-none");
    $("#app").inert = appWasInert;
    $("#addModal").inert = addWasInert;
    $("#reportTs").replaceChildren();
    if (!$("#reportDone").classList.contains("d-none")) resetForm();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const draft = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
    const problem = checkDraft(draft);
    if (problem) { showError(problem); return; }
    busy = true;
    $("#rSubmit").disabled = true;
    $("#rSpin").classList.remove("d-none");
    showError(null);
    try {
      let token = null;
      try {
        token = await tokenFor($("#reportTs"), "report");
      } catch {
        showError(botCheckError);
        return;
      }
      const body = new FormData();
      body.append("category", draft.category);
      body.append("title", draft.title.trim());
      body.append("details", draft.details.trim());
      for (const key of ["from", "to"]) if (draft[key]) body.append(key, new Date(draft[key]).toISOString());
      body.append("route", location.hash.split("?")[0].slice(0, 200));
      for (const item of items) body.append("images", item.file, item.file.name || "image");
      let res;
      try {
        res = await fetch("/api/report", { method: "POST", headers: token ? { "X-Turnstile-Token": token } : {}, body });
      } catch {
        showError("The report could not be sent. Check your connection and try again.");
        return;
      }
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !Number.isInteger(result.number)) {
        showError(result.error ? sentence(result.error) : "The report could not be filed. Try again later.");
        return;
      }
      $("#rNumber").textContent = String(result.number);
      $("#reportForm").classList.add("d-none");
      $("#reportDone").classList.remove("d-none");
      $("#rDoneClose").focus();
    } finally {
      busy = false;
      $("#rSubmit").disabled = false;
      $("#rSpin").classList.add("d-none");
      $("#reportTs").replaceChildren();
    }
  }

  function trapFocus(e) {
    const items = [...modal.querySelectorAll("button, input, select, textarea, a[href], [tabindex='0']")].filter((node) => !node.disabled && node.getClientRects().length);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    const active = document.activeElement;
    if (!modal.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener("keydown", (e) => {
    if (!openState) return;
    if (e.key === "Escape") { e.stopImmediatePropagation(); close(); }
    else if (e.key === "Tab") { e.stopImmediatePropagation(); trapFocus(e); }
  }, true);
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-report]");
    if (!target) return;
    if (target.dataset.report === "open") open();
    else if (target.dataset.report === "close") close();
  });
  document.addEventListener("paste", (e) => {
    if (!openState) return;
    const images = [...(e.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    addFiles(images);
  });
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });
  modal.addEventListener("dragover", (e) => { e.preventDefault(); $("#rDrop").classList.add("over"); });
  modal.addEventListener("dragleave", (e) => { if (!modal.contains(e.relatedTarget)) $("#rDrop").classList.remove("over"); });
  modal.addEventListener("drop", (e) => { e.preventDefault(); $("#rDrop").classList.remove("over"); addFiles(e.dataTransfer?.files ?? []); });
  $("#rPick").addEventListener("click", () => $("#rFile").click());
  $("#rDrop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#rFile").click(); } });
  $("#rFile").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("#rPreviews").addEventListener("click", (e) => {
    const target = e.target.closest("[data-remove]");
    if (target) dropItem(Number(target.dataset.remove));
  });
  fields.details.addEventListener("input", () => { $("#rDetailsCount").textContent = String(fields.details.value.length); });
  form.addEventListener("submit", submit);
  for (const button of document.querySelectorAll("[data-report=open]")) button.classList.remove("d-none");
}
