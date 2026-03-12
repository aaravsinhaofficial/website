(function () {
  var profileLink = document.querySelector('.profile-photo-link');

  if (profileLink) {
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
  }

  var mailingForms = document.querySelectorAll('.mailing-list-form');

  function setupMailingForm(form) {
    form.addEventListener('submit', function (event) {
      var recipient = form.getAttribute('action').replace(/^mailto:/, '');
      var emailInput = form.querySelector('.signup-input');
      var email;
      var subject;
      var body;

      event.preventDefault();

      if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
        return;
      }

      if (typeof form.reportValidity !== 'function' && typeof form.checkValidity === 'function' && !form.checkValidity()) {
        return;
      }

      if (!emailInput) {
        return;
      }

      email = emailInput.value.trim();
      subject = 'Mailing list signup';
      body = [
        'Please add me to the mailing list for website updates.',
        '',
        'Email: ' + email,
        'Source page: ' + window.location.href
      ].join('\n');

      window.location.href = 'mailto:' + recipient +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);
    });
  }

  for (var i = 0; i < mailingForms.length; i++) {
    setupMailingForm(mailingForms[i]);
  }
}());
