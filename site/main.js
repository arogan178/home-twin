const plan = document.querySelector(".plan");
const drawnSwitch = plan.querySelector(".switch");
const button = plan.querySelector(".switch-button");

function setLights(on) {
  plan.dataset.lights = on ? "on" : "off";
  drawnSwitch.setAttribute("aria-pressed", String(on));
  drawnSwitch.setAttribute("aria-label", `Wall switch S01. Switch the spotlights ${on ? "off" : "on"}`);
  button.setAttribute("aria-pressed", String(on));
  button.textContent = on ? "Switch off" : "Switch on";
}

function toggle() {
  setLights(plan.dataset.lights !== "on");
}

setLights(plan.dataset.lights === "on");
button.addEventListener("click", toggle);
drawnSwitch.addEventListener("click", toggle);
drawnSwitch.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggle();
});

// A light on the drawing and its entry in the transcript light up together.
function link(tag, on) {
  for (const element of document.querySelectorAll(`[data-fixture="${tag}"]`)) {
    element.classList.toggle("is-linked", on);
  }
}

for (const element of document.querySelectorAll("[data-fixture]")) {
  const tag = element.dataset.fixture;
  for (const [type, on] of [["pointerenter", true], ["pointerleave", false], ["focus", true], ["blur", false]]) {
    element.addEventListener(type, () => link(tag, on));
  }
}
