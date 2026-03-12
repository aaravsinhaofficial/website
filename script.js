(function () {
  var profileLink = document.querySelector('.profile-photo-link');

  if (!profileLink) {
    return;
  }

  profileLink.addEventListener('click', function (event) {
    var rect = profileLink.getBoundingClientRect();
    var radius = Math.min(rect.width, rect.height) / 2;
    var centerX = rect.left + (rect.width / 2);
    var centerY = rect.top + (rect.height / 2);
    var dx = event.clientX - centerX;
    var dy = event.clientY - centerY;

    if ((dx * dx) + (dy * dy) > (radius * radius)) {
      event.preventDefault();
      return;
    }

    if (dy < 0) {
      event.preventDefault();
      window.location.href = profileLink.dataset.secretHref;
    }
  });
}());
