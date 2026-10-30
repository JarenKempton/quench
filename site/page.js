const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const hero = document.querySelector(".hero-anim");
const revealed = document.querySelectorAll(".reveal");

const wide = {
  viewBox: "0 0 960 440",
  src: ["translate(40 50)", "translate(40 172)", "translate(40 294)"],
  flow: [
    "M270 96 C 340 96, 340 220, 410 220",
    "M270 218 C 340 218, 340 220, 410 220",
    "M270 340 C 340 340, 340 220, 410 220",
  ],
  core: "translate(410 186)",
  out: [
    "M540 220 C 590 220, 590 92, 640 92",
    "M540 220 C 590 220, 590 220, 640 220",
    "M540 220 C 590 220, 590 348, 640 348",
  ],
  res: ["translate(640 50)", "translate(640 178)", "translate(640 306)"],
};
const tall = {
  viewBox: "0 0 320 780",
  src: ["translate(45 10)", "translate(45 112)", "translate(45 214)"],
  flow: ["M160 102 L 160 112", "M160 204 L 160 214", "M160 306 L 160 352"],
  core: "translate(95 352)",
  out: ["M160 420 L 160 470", "M160 562 L 160 572", "M160 664 L 160 674"],
  res: ["translate(20 470)", "translate(20 572)", "translate(20 674)"],
};

function layout(shape) {
  hero.setAttribute("viewBox", shape.viewBox);
  hero.querySelectorAll(".src").forEach((g, i) => g.setAttribute("transform", shape.src[i]));
  hero.querySelectorAll(".flow").forEach((p, i) => p.setAttribute("d", shape.flow[i]));
  hero.querySelector(".core").setAttribute("transform", shape.core);
  hero.querySelectorAll(".out").forEach((p, i) => p.setAttribute("d", shape.out[i]));
  hero.querySelectorAll(".res").forEach((g, i) => g.setAttribute("transform", shape.res[i]));
}

const narrow = matchMedia("(max-width: 600px)");
layout(narrow.matches ? tall : wide);
narrow.addEventListener("change", (e) => layout(e.matches ? tall : wide));

if (!reduced) requestAnimationFrame(() => hero.classList.add("play"));

if (reduced || !("IntersectionObserver" in window)) {
  revealed.forEach((el) => el.classList.add("in"));
} else {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.15 },
  );
  revealed.forEach((el) => seen.observe(el));
}

for (const box of document.querySelectorAll("[data-copy]")) {
  const button = box.querySelector("button");
  const text = box.querySelector("code").textContent;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "copied";
      button.classList.add("done");
      setTimeout(() => {
        button.textContent = "copy";
        button.classList.remove("done");
      }, 1600);
    } catch {
      button.textContent = "select it";
    }
  });
}
