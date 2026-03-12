(function () {
  var profileLink = document.querySelector('.profile-photo-link');
  var mailingForms = document.querySelectorAll('.mailing-list-form');

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

  function setFeedback(feedback, message, isError) {
    if (!feedback) {
      return;
    }

    feedback.textContent = message;
    feedback.classList.toggle('is-error', Boolean(isError));
    feedback.classList.toggle('is-success', !isError && message !== '');
  }

  function setupMailingForm(form) {
    var button = form.querySelector('.signup-button');
    var feedback = form.querySelector('.signup-feedback');
    var action = form.getAttribute('action');
    var ajaxAction = action.replace('https://formsubmit.co/', 'https://formsubmit.co/ajax/');

    form.addEventListener('submit', function (event) {
      var request = new XMLHttpRequest();
      var formData = new FormData(form);
      var originalButtonText = button ? button.textContent : '';

      event.preventDefault();

      if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
        return;
      }

      if (typeof form.reportValidity !== 'function' && typeof form.checkValidity === 'function' && !form.checkValidity()) {
        return;
      }

      setFeedback(feedback, '', false);

      if (button) {
        button.disabled = true;
        button.textContent = 'Joining...';
      }

      request.open('POST', ajaxAction, true);
      request.setRequestHeader('Accept', 'application/json');

      request.onreadystatechange = function () {
        var response = {};
        var failed;

        if (request.readyState !== 4) {
          return;
        }

        if (button) {
          button.disabled = false;
          button.textContent = originalButtonText;
        }

        try {
          response = JSON.parse(request.responseText);
        } catch (error) {
          response = {};
        }

        failed = request.status < 200 || request.status >= 300 ||
          response.success === false || response.success === 'false';

        if (failed) {
          setFeedback(
            feedback,
            response.message || 'That signup did not go through. Try again in a moment.',
            true
          );
          return;
        }

        form.reset();
        setFeedback(feedback, 'Thanks. You are on the mailing list.', false);
      };

      request.onerror = function () {
        if (button) {
          button.disabled = false;
          button.textContent = originalButtonText;
        }

        setFeedback(feedback, 'Network error. Try again in a moment.', true);
      };

      request.send(formData);
    });
  }

  for (var i = 0; i < mailingForms.length; i++) {
    setupMailingForm(mailingForms[i]);
  }
}());
