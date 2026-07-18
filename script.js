(function () {
  var profileLink = document.querySelector('.profile-photo-link');
  var mailingForms = document.querySelectorAll('.mailing-list-form');
  var chatbotEndpoint = '/api/chat';
  var visitEndpoint = '/api/visit';

  function shouldSkipVisitTracking() {
    return Boolean(
      navigator.globalPrivacyControl ||
      navigator.doNotTrack === '1' ||
      window.doNotTrack === '1'
    );
  }

  function getTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (error) {
      return '';
    }
  }

  function trackVisit() {
    var payload;
    var blob;

    if (shouldSkipVisitTracking()) {
      return;
    }

    payload = JSON.stringify({
      path: window.location.pathname + window.location.search,
      title: document.title,
      referrer: document.referrer,
      timezone: getTimezone()
    });

    if (navigator.sendBeacon) {
      blob = new Blob([payload], { type: 'application/json' });

      if (navigator.sendBeacon(visitEndpoint, blob)) {
        return;
      }
    }

    if (window.fetch) {
      fetch(visitEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: payload,
        credentials: 'same-origin',
        keepalive: true
      }).catch(function () {});
    }
  }

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

  function createChatbotElement() {
    var chatbot = document.createElement('section');

    chatbot.className = 'chatbot-widget';
    chatbot.setAttribute('aria-label', 'Ask about Aarav');
    chatbot.innerHTML = '' +
      '<div class="chatbot-panel" id="chatbot-panel" hidden>' +
        '<div class="chatbot-header">' +
          '<div>' +
            '<h2>Ask about Aarav</h2>' +
          '</div>' +
          '<button class="chatbot-close" type="button" aria-label="Close chat">x</button>' +
        '</div>' +
        '<div class="chatbot-messages" role="log" aria-live="polite" aria-relevant="additions"></div>' +
        '<div class="chatbot-prompts" aria-label="Suggested questions">' +
          '<button type="button" data-chatbot-prompt="What research is Aarav working on?">Research</button>' +
          '<button type="button" data-chatbot-prompt="How can I contact Aarav?">Contact</button>' +
          '<button type="button" data-chatbot-prompt="What has Aarav written about recently?">Blog</button>' +
        '</div>' +
        '<form class="chatbot-form">' +
          '<label class="visually-hidden" for="chatbot-input">Message</label>' +
          '<input id="chatbot-input" name="message" autocomplete="off" maxlength="1200" placeholder="Ask a question" required>' +
          '<button type="submit">Send</button>' +
        '</form>' +
      '</div>' +
      '<button class="chatbot-toggle" type="button" aria-controls="chatbot-panel" aria-expanded="false">Ask AI</button>';

    return chatbot;
  }

  function setupChatbot() {
    var chatbot = createChatbotElement();
    var panel = chatbot.querySelector('.chatbot-panel');
    var toggle = chatbot.querySelector('.chatbot-toggle');
    var closeButton = chatbot.querySelector('.chatbot-close');
    var form = chatbot.querySelector('.chatbot-form');
    var input = chatbot.querySelector('#chatbot-input');
    var sendButton = form.querySelector('button');
    var messagesList = chatbot.querySelector('.chatbot-messages');
    var promptButtons = chatbot.querySelectorAll('[data-chatbot-prompt]');
    var messages = [];
    var isBusy = false;

    function setOpen(isOpen) {
      panel.hidden = !isOpen;
      toggle.setAttribute('aria-expanded', String(isOpen));

      if (isOpen) {
        input.focus();
      }
    }

    function appendCitations(message, citations) {
      var list;

      if (!citations || !citations.length) {
        return;
      }

      list = document.createElement('ul');
      list.className = 'chatbot-citations';

      citations.slice(0, 5).forEach(function (citation) {
        var item = document.createElement('li');
        var link = document.createElement('a');

        link.href = citation.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = citation.title || citation.url;
        item.appendChild(link);
        list.appendChild(item);
      });

      message.appendChild(list);
    }

    function setMessageContent(message, text, citations) {
      message.textContent = text;
      appendCitations(message, citations);
    }

    function appendMessage(role, text, isLoading, citations) {
      var message = document.createElement('div');

      message.className = 'chatbot-message chatbot-message-' + role;
      setMessageContent(message, text, citations);

      if (isLoading) {
        message.classList.add('is-loading');
      }

      messagesList.appendChild(message);
      messagesList.scrollTop = messagesList.scrollHeight;

      return message;
    }

    function setBusy(busy) {
      input.disabled = busy;
      sendButton.disabled = busy;

      for (var i = 0; i < promptButtons.length; i++) {
        promptButtons[i].disabled = busy;
      }
    }

    function getErrorMessage(error, status) {
      if (status === 404) {
        return 'The chat endpoint is not running yet. Deploy with the serverless API and set OPENAI_API_KEY.';
      }

      return error || 'The chat is unavailable right now. Try again in a moment.';
    }

    function sendMessage(text) {
      var loadingMessage;

      if (!text || isBusy) {
        return;
      }

      isBusy = true;
      appendMessage('user', text, false);
      messages.push({ role: 'user', content: text });
      loadingMessage = appendMessage('assistant', 'Thinking...', true);
      setBusy(true);

      fetch(chatbotEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: messages.slice(-10)
        })
      })
        .then(function (response) {
          return response.json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              if (!response.ok) {
                throw {
                  message: getErrorMessage(body.error, response.status)
                };
              }

              return body;
            });
        })
        .then(function (body) {
          var reply = body.reply || 'I could not find an answer from the site context.';

          if (loadingMessage.parentNode) {
            loadingMessage.parentNode.removeChild(loadingMessage);
          }
          appendMessage('assistant', reply, false, body.citations);
          messages.push({ role: 'assistant', content: reply });
        })
        .catch(function (error) {
          var errorMessage;

          if (loadingMessage.parentNode) {
            loadingMessage.parentNode.removeChild(loadingMessage);
          }
          errorMessage = appendMessage('assistant', error.message || getErrorMessage('', 0), false);
          errorMessage.classList.add('is-error');
          messages.pop();
        })
        .finally(function () {
          isBusy = false;
          setBusy(false);
          input.focus();
          messagesList.scrollTop = messagesList.scrollHeight;
        });
    }

    document.body.appendChild(chatbot);
    appendMessage('assistant', "Hi, I am Aarav's site assistant.", false);
    setOpen(false);

    toggle.addEventListener('click', function () {
      setOpen(panel.hidden);
    });

    closeButton.addEventListener('click', function () {
      setOpen(false);
      toggle.focus();
    });

    form.addEventListener('submit', function (event) {
      var text = input.value.trim();

      event.preventDefault();
      input.value = '';
      sendMessage(text);
    });

    for (var i = 0; i < promptButtons.length; i++) {
      promptButtons[i].addEventListener('click', function () {
        sendMessage(this.getAttribute('data-chatbot-prompt'));
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  function setupThemeToggle() {
    var root = document.documentElement;
    var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var LIGHT_COLOR = '#f5efe2';
    var DARK_COLOR = '#211c16';
    var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>';
    var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"></line><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"></line><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"></line></svg>';
    var button = document.createElement('button');

    button.className = 'theme-toggle';
    button.type = 'button';

    function storedPreference() {
      try {
        var value = localStorage.getItem('theme');
        return (value === 'light' || value === 'dark') ? value : null;
      } catch (error) {
        return null;
      }
    }

    function storePreference(value) {
      try {
        localStorage.setItem('theme', value);
      } catch (error) {}
    }

    function systemTheme() {
      return (darkQuery && darkQuery.matches) ? 'dark' : 'light';
    }

    function effectiveTheme() {
      var attr = root.getAttribute('data-theme');
      return (attr === 'light' || attr === 'dark') ? attr : systemTheme();
    }

    function updateThemeColor(explicit, resolved) {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      var i;
      var meta;
      var media;

      for (i = 0; i < metas.length; i++) {
        meta = metas[i];

        if (explicit) {
          meta.setAttribute('content', resolved === 'dark' ? DARK_COLOR : LIGHT_COLOR);
        } else {
          media = meta.getAttribute('media') || '';
          meta.setAttribute('content', media.indexOf('dark') !== -1 ? DARK_COLOR : LIGHT_COLOR);
        }
      }
    }

    function render() {
      var effective = effectiveTheme();
      var target = effective === 'dark' ? 'light' : 'dark';

      button.innerHTML = effective === 'dark' ? SUN : MOON;
      button.setAttribute('aria-label', 'Switch to ' + target + ' theme');
      button.setAttribute('title', 'Switch to ' + target + ' theme');
    }

    // The inline <head> script already applied any stored preference; mirror it
    // in the address-bar chrome and the icon, then let clicks take over.
    if (storedPreference()) {
      updateThemeColor(true, effectiveTheme());
    }
    render();

    button.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';

      root.setAttribute('data-theme', next);
      storePreference(next);
      updateThemeColor(true, next);
      render();
    });

    if (darkQuery) {
      var onSystemChange = function () {
        if (!storedPreference()) {
          updateThemeColor(false);
          render();
        }
      };

      if (darkQuery.addEventListener) {
        darkQuery.addEventListener('change', onSystemChange);
      } else if (darkQuery.addListener) {
        darkQuery.addListener(onSystemChange);
      }
    }

    document.body.appendChild(button);
  }

  if (document.body) {
    setupThemeToggle();
    setupChatbot();
    trackVisit();
  }
}());
