const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const hero = document.querySelector(".hero-anim");
const revealed = document.querySelectorAll(".reveal");

const narrow = matchMedia("(max-width: 600px)");
const frame = () => hero.setAttribute("viewBox", narrow.matches ? "120 10 780 490" : "0 0 900 500");
frame();
narrow.addEventListener("change", frame);

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
