const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealed = document.querySelectorAll(".reveal");

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
    { rootMargin: "0px 0px -8% 0px", threshold: 0.1 },
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
