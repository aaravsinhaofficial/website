const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4.1-mini';
const MAX_MESSAGE_CHARS = 1200;
const MAX_HISTORY_MESSAGES = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitBuckets = new Map();

const PROFILE_CONTEXT = `
Aarav Sinha is a student researcher interested in computational neuroscience, connectomics, embodied neural models, deep reinforcement learning, and how biological neural circuits give rise to behavior.

Current roles and education:
- Research intern at Johns Hopkins University in the Dynamical Intelligence Group, studying the computational theory of predictive grid cells in the medial entorhinal cortex.
- Computational neuroscience intern at Eon Systems PBC, working on embodied Drosophila brain models and brain-body-environment simulations.
- Sophomore at Tompkins High School in Katy, Texas, ranked 5th out of 800+ students with a 4.0 GPA.
- USACO Gold competitor, Science Olympiad state medalist, and founder of his school's AI Club and Engineering Club.

Previous research:
- Summer researcher at Harvard University's Kempner Institute, training RNN agents for odor plume tracking.
- Student research assistant at the UC Davis Center for Neuroscience.

Research and publications listed on the site:
- "MapShift: Controlled Post-Intervention Evaluation for Embodied World Models" by Aarav Sinha, accepted to the ICML 2026 RLxF Workshop: Reinforcement Learning from World Feedback.
- "Can AI Scientists Discover Neural Mechanisms? Evaluating Agentic Biological Discovery in a Digital Fly" by Aarav Sinha, accepted to the ICML 2026 GenBio Workshop: Generative and Agentic AI for Biology.
- "Credit Bandwidth Lower Bounds for Diffusive Cortical Learning" by Aarav Sinha, Research Square preprint, 2026.
- "Using Deep Reinforcement Learning to Understand Odor Plume Tracking in Walking and Flying Insects" by Satpreet H. Singh and Aarav Sinha, NeurIPS AI for Science Workshop, 2025.
- "Towards Embodied Brain Emulations: A Drosophila Connectome-Constrained Brain Model Accurately Predicts Neural Activity and Controls Behavior in a Virtual Environment" by Scott Harris, Aarav Sinha, Susanna Yaeger-Weiss, Vincent Louvel, and Philip Shiu, Society for Neuroscience, 2025 poster.

Blog notes:
- "An ICML Update" says Aarav received encouraging reviews on an ICML submission and was optimistic about final acceptance.
- "Going Viral: 100M+ Views on Embodied Brain Emulation" describes Eon Systems work on embodied Drosophila brain emulation going viral across social platforms. Aarav contributed to the brain embodiment component, coupling a connectome-constrained neural network to a virtual fly body in a physics-based environment.
- "Welcome to My Blog" introduces the blog as a place for thoughts on neuroscience, computation, reinforcement learning, connectomics, and related topics.

Useful links:
- Email: aaravsinha002@gmail.com
- GitHub: https://github.com/aaravsinhaofficial
- LinkedIn: https://www.linkedin.com/in/aaravsinha1/
- Google Scholar: https://scholar.google.com/citations?user=pQ0MDVwAAAAJ&hl=en
- Website: https://aaravsinha.dev/
- Blog: https://aaravsinha.dev/blog.html
- CV: https://aaravsinha.dev/Resume-(Aarav%20Sinha)%20(7).pdf
`;

const SYSTEM_PROMPT = `
You are the chatbot on Aarav Sinha's personal website. Answer questions about Aarav using only the profile context below and the conversation so far.

Style:
- Be concise, friendly, and specific.
- Speak about Aarav in the third person unless the user explicitly asks you to draft text in Aarav's voice.
- Do not claim to be Aarav.
- If a question asks for something not present in the context, say you do not know from the website and suggest emailing Aarav.
- For collaboration, recruiting, speaking, or press questions, direct the user to aaravsinha002@gmail.com.
- Do not invent publications, awards, affiliations, statistics, or personal details.

Profile context:
${PROFILE_CONTEXT}
`;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter(function (message) {
      return message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string';
    })
    .slice(-MAX_HISTORY_MESSAGES)
    .map(function (message) {
      return {
        role: message.role,
        content: message.content.trim().slice(0, MAX_MESSAGE_CHARS)
      };
    })
    .filter(function (message) {
      return message.content.length > 0;
    });
}

function extractOutputText(responseBody) {
  if (typeof responseBody.output_text === 'string' && responseBody.output_text.trim() !== '') {
    return responseBody.output_text.trim();
  }

  if (!Array.isArray(responseBody.output)) {
    return '';
  }

  return responseBody.output
    .map(function (item) {
      if (!item || !Array.isArray(item.content)) {
        return '';
      }

      return item.content
        .map(function (part) {
          if (!part) {
            return '';
          }

          if (typeof part.text === 'string') {
            return part.text;
          }

          if (typeof part.value === 'string') {
            return part.value;
          }

          return '';
        })
        .join('');
    })
    .join('\n')
    .trim();
}

function getClientIp(req) {
  const forwardedFor = req.headers && req.headers['x-forwarded-for'];
  const realIp = req.headers && req.headers['x-real-ip'];

  if (typeof forwardedFor === 'string' && forwardedFor.trim() !== '') {
    return forwardedFor.split(',')[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return forwardedFor[0].split(',')[0].trim();
  }

  if (typeof realIp === 'string' && realIp.trim() !== '') {
    return realIp.trim();
  }

  return 'unknown';
}

function isRateLimited(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const bucket = rateLimitBuckets.get(ip);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(ip, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX_REQUESTS;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 500, {
      error: 'Chat is not configured yet. Set OPENAI_API_KEY in the deployment environment.'
    });
    return;
  }

  if (isRateLimited(req)) {
    sendJson(res, 429, { error: 'Too many chat requests. Try again later.' });
    return;
  }

  const messages = normalizeMessages(req.body && req.body.messages);
  const lastMessage = messages[messages.length - 1];

  if (!lastMessage || lastMessage.role !== 'user') {
    sendJson(res, 400, { error: 'Send at least one user message.' });
    return;
  }

  try {
    const openaiResponse = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        instructions: SYSTEM_PROMPT,
        input: messages,
        max_output_tokens: 450,
        store: false,
        temperature: 0.3
      })
    });

    const responseBody = await openaiResponse.json().catch(function () {
      return {};
    });

    if (!openaiResponse.ok) {
      sendJson(res, openaiResponse.status, {
        error: responseBody.error && responseBody.error.message
          ? responseBody.error.message
          : 'The model request failed.'
      });
      return;
    }

    const reply = extractOutputText(responseBody);

    sendJson(res, 200, {
      reply: reply || 'I could not generate an answer from the site context.'
    });
  } catch (error) {
    sendJson(res, 500, { error: 'Network error while contacting the model.' });
  }
};
