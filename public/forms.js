/* perchlight-forms snippet (optional, no dependencies). Forms work without it.
   <form data-perchlight action="https://forms.example.com/f/contact" method="post">
   Shows errors in [data-error-for="<field>"] and [data-form-status], and fills
   _elapsed (time on the page) for the too-fast check. */
(function () {
  var t0 = Date.now();
  document.querySelectorAll("form[data-perchlight]").forEach(function (f) {
    var el = document.createElement("input");
    el.type = "hidden"; el.name = "_elapsed"; f.appendChild(el);
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      el.value = String(Date.now() - t0);
      var status = f.querySelector("[data-form-status]");
      f.querySelectorAll("[data-error-for]").forEach(function (e) { e.textContent = ""; });
      var b = f.querySelector("[type=submit]"); if (b) b.disabled = true;
      fetch(f.action, { method: "POST", body: new FormData(f), headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok) {
            if (f.dataset.thanks) location.href = f.dataset.thanks;
            else { f.reset(); if (status) status.textContent = "Thanks, your message was sent."; }
            return;
          }
          Object.keys(d.errors || {}).forEach(function (k) {
            var e = f.querySelector('[data-error-for="' + k + '"]') || status;
            if (e) e.textContent = d.errors[k];
          });
          if (window.turnstile) window.turnstile.reset();
        })
        .catch(function () { if (status) status.textContent = "Couldn't send. Please try again."; })
        .then(function () { if (b) b.disabled = false; });
    });
  });
})();
