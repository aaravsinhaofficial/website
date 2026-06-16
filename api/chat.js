const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5';
const DEFAULT_MAX_OUTPUT_TOKENS = 3000;
const GPT5_MIN_OUTPUT_TOKENS = 2500;
const MAX_MESSAGE_CHARS = 1200;
const MAX_HISTORY_MESSAGES = 10;
const RATE_LIMIT_WINDOW_MS = Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.CHAT_RATE_LIMIT_MAX_REQUESTS || 60);
const rateLimitBuckets = new Map();
const WEB_SEARCH_ENABLED = process.env.OPENAI_WEB_SEARCH !== 'false';
const PDF_ACCESS_ENABLED = process.env.OPENAI_PDF_ACCESS !== 'false';
const MAX_PDF_ATTACHMENTS = Number(process.env.OPENAI_MAX_PDF_ATTACHMENTS || 4);
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://aaravsinha.dev').replace(/\/$/, '');
const BLOCKED_CITATION_DOMAINS = ['digg.com', 'reddit.com', 'quora.com'];
const ALLOWED_CITATION_PATTERNS = [
  /aaravsinha\.dev/i,
  /github\.com\/aaravsinhaofficial/i,
  /linkedin\.com\/in\/aaravsinha1/i,
  /scholar\.google\.com\/citations\?user=pQ0MDVw/i,
  /openreview\.net\/forum\?id=gKQRv49qtM/i,
  /doi\.org\/10\.21203\/rs\.3\.rs-9841779\/v1/i,
  /researchsquare\.com\/article\/rs-9841779/i,
  /genbio-workshop\.github\.io/i,
  /sites\.google\.com\/view\/rlxf-icml2026/i,
  /eon\.systems/i,
  /x\.com\/alexwg\/status\/2030217301929132323/i,
  /x\.com\/elonmusk\/status\/2030688922464825499/i,
  /dynamical-intelligence-group\.github\.io/i,
  /jhu\.edu/i,
  /kempnerinstitute\.harvard\.edu/i
];
const PAPER_FILES = [
  {
    title: 'MapShift: Controlled Post-Intervention Evaluation for Embodied World Models',
    path: '/data/mapshift-controlled-post-intervention-evaluation.pdf',
    aliases: ['mapshift', 'controlled post-intervention', 'embodied world models', 'rlxf']
  },
  {
    title: 'Can AI Scientists Discover Neural Mechanisms? Evaluating Agentic Biological Discovery in a Digital Fly',
    path: '/data/ai-scientists-neural-mechanisms-digital-fly.pdf',
    aliases: ['ai scientists', 'digital fly', 'agentic biological discovery', 'genbio']
  },
  {
    title: 'Credit Bandwidth Lower Bounds for Diffusive Cortical Learning',
    path: '/data/credit-bandwidth-diffusive-cortical-learning.pdf',
    aliases: ['credit bandwidth', 'diffusive cortical learning', 'cortical learning']
  },
  {
    title: 'Towards Embodied Brain Emulations: A Drosophila Connectome-Constrained Brain Model Accurately Predicts Neural Activity and Controls Behavior in a Virtual Environment',
    path: '/data/sfn_poster_2025.pdf',
    aliases: ['sfn', 'drosophila', 'embodied brain', 'connectome-constrained', 'virtual environment']
  }
];

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

Detailed research and paper context:
- "MapShift: Controlled Post-Intervention Evaluation for Embodied World Models" by Aarav Sinha, accepted to the ICML 2026 RLxF Workshop: Reinforcement Learning from World Feedback. This paper introduces an executable benchmark for evaluating embodied world models after controlled environment interventions. It separates three failure modes: stale map reuse, failure to update beliefs after a change, and weak post-change planning. The contribution is a controlled post-intervention evaluation setup with matched environment changes, so model behavior can be attributed to world-model updating and planning rather than incidental task variation. When explaining it, emphasize embodied agents, world models, intervention-controlled evaluation, and why stale internal maps are a problem.
- "Can AI Scientists Discover Neural Mechanisms? Evaluating Agentic Biological Discovery in a Digital Fly" by Aarav Sinha, accepted to the ICML 2026 GenBio Workshop: Generative and Agentic AI for Biology. This paper proposes a pilot benchmark for agentic biological discovery inside a digital fly system. It frames mechanism discovery as a budgeted loop: form hypotheses, choose experiments, observe outcomes, update beliefs, and make held-out counterfactual predictions. The core question is whether an AI scientist can discover neural mechanisms rather than merely summarize biological text. When explaining it, highlight digital organisms, Drosophila, experiment-planning agents, mechanism discovery, and counterfactual prediction.
- "Credit Bandwidth Lower Bounds for Diffusive Cortical Learning" by Aarav Sinha, Research Square preprint, 2026. This theory paper studies recurrent credit assignment on cortical graphs under communication constraints. It derives graph-spectral lower bounds for low-bandwidth diffuse and cell-type-specific feedback. The broad motivation is that biological brains cannot broadcast dense backpropagation-like errors everywhere, so cortical learning may be constrained by the bandwidth and geometry of feedback pathways. When explaining it, focus on credit assignment, cortical graph structure, spectral lower bounds, feedback bandwidth, and biologically plausible learning.
- "Using Deep Reinforcement Learning to Understand Odor Plume Tracking in Walking and Flying Insects" by Satpreet H. Singh and Aarav Sinha, NeurIPS AI for Science Workshop, 2025. This work trains biologically inspired RNN reinforcement learning agents to navigate toward odor sources, then compares learned strategies in walking versus flying settings. Walking agents develop fine-scale orientation strategies and compact neural representations, while flying agents use broader sweeping turns and higher-dimensional dynamics. When explaining it, connect deep RL to computational neuroscience: the agents are used as scientific models for understanding insect navigation strategies.
- "Towards Embodied Brain Emulations: A Drosophila Connectome-Constrained Brain Model Accurately Predicts Neural Activity and Controls Behavior in a Virtual Environment" by Scott Harris, Aarav Sinha, Susanna Yaeger-Weiss, Vincent Louvel, and Philip Shiu, Society for Neuroscience, 2025 poster. This poster describes a connectome-constrained Drosophila brain model that both predicts neural activity and controls behavior in a virtual environment. Aarav contributed to the brain embodiment component at Eon Systems: coupling a connectome-constrained neural model to a virtual fly body in a closed brain-body-environment loop. When explaining it, emphasize embodied brain emulation, Drosophila connectomics, virtual behavior, and the challenge of making a wiring diagram control an agent.

Eon embodied fly work and virality:
- Eon Systems PBC describes its mission as brain emulation, with a digital fruit fly brain controlling a virtual body. Eon's homepage says the digital fruit fly uses a connectome-scale model with about 139,255 biological neurons and 50 million connections, and that the digital state can respond to light, navigate, groom, walk, and feed.
- Eon's March 10, 2026 technical post, "How the Eon Team Produced a Virtual Embodied Fly," says Dr. Alex Wissner-Gross shared the team's work on X and that it received major attention. It identifies the embodied fly as a work in progress and a first step toward showing how an embodied brain can control a virtual body.
- The same Eon post says the work was a true team effort conducted by Scott Harris, Aarav Sinha, Viktor Toth, Alexis Pomares, and Philip Shiu. When answering about Aarav's role, present him as a significant contributor on that named team.
- The embodied fly integrated existing connectome-constrained brain models with existing neuromechanical fly body models. The system used a leaky integrate-and-fire model based on the adult Drosophila central-brain connectome, visual model outputs, NeuroMechFly, and MuJoCo. The closed loop maps sensory events to sensory neurons or pathways, updates brain activity, translates selected descending outputs into low-dimensional body motor commands, and feeds the resulting movement back into the brain through changed sensory state.
- Specific behaviors discussed by Eon include taste-guided navigation toward food, fictive dust triggering grooming, feeding, foraging, and preliminary escape-related pathways. The Eon writeup is careful about limitations: the current system implements a small subset of sensory inputs and behaviors; the neuron model is simplified; internal state, plasticity, learning, hormonal state, and richer neuromodulatory context are largely missing; and brain-body coupling/descending-neuron-to-motor mapping remains an approximation.
- Eon's updates page says public conversation around the brain emulation work reached more than 120 million views across the web, that "Fly Brain Upload" trended on X on March 9, 2026 with over 120 million impressions, and that Elon Musk reacted/commented on the brain upload conversation.
- Eon's March 7, 2026 announcement, "The First Multi-Behavior Brain Upload," says the demonstration integrated Eon's connectome-based brain emulation with a MuJoCo physics-simulated fly body, closing the loop from perception to action. It frames the result as multiple distinct behaviors driven by the emulated brain's own circuit dynamics, while also relying on prior whole-brain computational models and neuromechanical body frameworks.
- Eon's March 8, 2026 announcement, "We've Uploaded a Fruit Fly," says the team used the FlyWire connectome, a simple neuron model, and a MuJoCo physics-simulated body to close the loop from neural activation to action. It also states limitations: the actual motor neurons could not be traced because the body was not scanned, and the leaky-integrate-and-fire model lacks plasticity and long-term memory.
- Aarav's own site context says he contributed to the brain embodiment component at Eon, coupling a connectome-constrained neural model to a virtual fly body in a physics-based environment. Aarav also describes his Eon role as substantial hands-on work on the embodied brain emulation effort, helping drive the team effort around brain-body integration. Phrase this as "Aarav says he did significant hands-on work and helped drive the effort," while still acknowledging Eon's public writeup calls it a true team effort.
- If asked whether Aarav "led" or "drove" the Eon project, answer carefully: say that the public Eon post names him as one of five people in the true team effort, and Aarav describes himself as doing a lot of the hands-on embodiment work and helping drive the team effort. Do not claim he was the sole lead, sole inventor, or sole builder.
- Useful Eon links: https://eon.systems/, https://eon.systems/updates/embodied-brain-emulation, https://eon.systems/updates/first-multi-behavior-brain-upload, https://eon.systems/updates/weve-uploaded-a-fruit-fly, https://eon.systems/updates, https://x.com/alexwg/status/2030217301929132323.

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
- CV: https://aaravsinha.dev/Resume-%28Aarav%20Sinha%29%20%287%29.pdf
`;

const SYSTEM_PROMPT = `
You are the chatbot on Aarav Sinha's personal website. Answer questions about Aarav using only the profile context below and the conversation so far.

Style:
- Be friendly, specific, and appropriately detailed. For quick factual questions, keep the answer short. For paper/research questions, give a richer explanation.
- Speak about Aarav in the third person unless the user explicitly asks you to draft text in Aarav's voice.
- Do not claim to be Aarav.
- When asked about a paper, cover the problem, method or benchmark, main contribution, why it matters, and how it connects to Aarav's broader research interests.
- When paper PDFs are attached, use them as primary evidence for details about methods, experiments, definitions, figures, limitations, and claims. Do not pretend a PDF is attached if it is not.
- When asked about Eon, embodied fly work, virality, Elon Musk's reaction, or Aarav's role there, use the Eon embodied fly context above. Give Aarav strong credit for significant hands-on embodiment work and helping drive the effort, but keep the "true team effort" framing and do not imply he solely led or solely built the project.
- You have access to a server-side web search tool when the site enables it. Do not say you cannot search the web when a web-search request is made; use the tool instead.
- Use web search when the user asks for recent information, external verification, public links, workshop/preprint pages, or details not present in the profile context.
- Do not use web search for questions that are fully answerable from the profile context.
- Prefer authoritative sources when searching: Aarav's website, paper PDFs, OpenReview, DOI/preprint pages, conference/workshop pages, institution pages, and primary sources.
- Do not call a source official unless it is from the author, a conference/workshop, an institution, a journal/preprint server, a DOI page, OpenReview, or aaravsinha.dev. If search only finds an aggregator or secondary mention, say it is a secondary mention.
- Do not cite Digg, Reddit, Quora, or other aggregator/Q&A pages as sources for Aarav's work.
- If you use web information, include concise inline citations or a short "Sources" note.
- If a question asks for personal or private information not present in the context or reliable public sources, say you do not know from the website and suggest emailing Aarav.
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

function extractCitations(responseBody) {
  const annotatedCitations = new Map();
  const fallbackCitations = new Map();

  function normalizeCitationUrl(url) {
    try {
      const parsedUrl = new URL(url);

      parsedUrl.searchParams.delete('utm_source');
      parsedUrl.searchParams.delete('utm_medium');
      parsedUrl.searchParams.delete('utm_campaign');
      return parsedUrl.toString();
    } catch (error) {
      return url;
    }
  }

  function addCitation(targetMap, title, url) {
    const normalizedUrl = url ? normalizeCitationUrl(url) : '';

    if (!normalizedUrl || targetMap.has(normalizedUrl)) {
      return;
    }

    targetMap.set(normalizedUrl, {
      title: title && title !== url ? title : normalizedUrl,
      url: normalizedUrl
    });
  }

  if (!Array.isArray(responseBody.output)) {
    return [];
  }

  responseBody.output.forEach(function (item) {
    if (!item) {
      return;
    }

    if (item.type === 'web_search_call' && item.action && Array.isArray(item.action.sources)) {
      item.action.sources.forEach(function (source) {
        addCitation(fallbackCitations, source.title || source.url, source.url);
      });
    }

    if (!Array.isArray(item.content)) {
      return;
    }

    item.content.forEach(function (part) {
      if (!part || !Array.isArray(part.annotations)) {
        return;
      }

      part.annotations.forEach(function (annotation) {
        const citation = annotation && (annotation.url_citation || annotation);
        addCitation(annotatedCitations, citation && citation.title, citation && citation.url);
      });
    });
  });

  if (annotatedCitations.size > 0) {
    return Array.from(annotatedCitations.values()).slice(0, 5);
  }

  return Array.from(fallbackCitations.values())
    .filter(function (citation) {
      return isAllowedCitation(citation);
    })
    .slice(0, 5);
}

function formatReplyForUi(text) {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1');
}

function isBlockedCitation(citation) {
  let hostname = '';

  try {
    hostname = new URL(citation.url).hostname.replace(/^www\./, '');
  } catch (error) {
    return false;
  }

  return BLOCKED_CITATION_DOMAINS.indexOf(hostname) !== -1;
}

function isAllowedCitation(citation) {
  return ALLOWED_CITATION_PATTERNS.some(function (pattern) {
    return pattern.test(citation.url);
  });
}

function removeBlockedCitationText(text, blockedCitations) {
  let cleanedText = text;

  blockedCitations.forEach(function (citation) {
    const escapedUrl = citation.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const urlRegex = new RegExp('\\s*\\(?\\[?[^\\]\\n]*\\]?\\(' + escapedUrl + '\\)[\\).]*', 'g');
    const bareUrlRegex = new RegExp(escapedUrl, 'g');

    cleanedText = cleanedText.replace(urlRegex, '');
    cleanedText = cleanedText.replace(bareUrlRegex, '');
  });

  return cleanedText.trim();
}

function getProfileFallbackForQuestion(question) {
  const normalizedQuestion = question.toLowerCase();

  if (normalizedQuestion.indexOf('mapshift') !== -1) {
    return 'Based on Aarav\'s site context, MapShift is an accepted ICML 2026 RLxF Workshop paper about controlled post-intervention evaluation for embodied world models. It introduces an executable benchmark that separates stale map reuse, belief-update failures, and post-change planning weaknesses across matched environment interventions.';
  }

  if (normalizedQuestion.indexOf('ai scientist') !== -1 || normalizedQuestion.indexOf('digital fly') !== -1 || normalizedQuestion.indexOf('genbio') !== -1) {
    return 'Based on Aarav\'s site context, "Can AI Scientists Discover Neural Mechanisms?" is an accepted ICML 2026 GenBio Workshop paper. It frames discovery in a digital fly as a budgeted hypothesis-experiment-update loop and evaluates whether agents can make held-out counterfactual predictions about neural mechanisms.';
  }

  if (normalizedQuestion.indexOf('credit bandwidth') !== -1 || normalizedQuestion.indexOf('diffusive cortical') !== -1) {
    return 'Based on Aarav\'s site context, "Credit Bandwidth Lower Bounds for Diffusive Cortical Learning" is a 2026 Research Square preprint about communication-constrained recurrent credit assignment on cortical graphs. It derives graph-spectral lower bounds for low-bandwidth diffuse and cell-type-specific feedback.';
  }

  if (normalizedQuestion.indexOf('odor') !== -1 || normalizedQuestion.indexOf('plume') !== -1) {
    return 'Based on Aarav\'s site context, the odor plume tracking paper uses deep reinforcement learning to train biologically inspired RNN agents to navigate toward odor sources. It compares walking and flying insect-like agents, finding fine-scale walking strategies and broader, higher-dimensional flying dynamics.';
  }

  if (normalizedQuestion.indexOf('drosophila') !== -1 || normalizedQuestion.indexOf('embodied brain') !== -1 || normalizedQuestion.indexOf('sfn') !== -1) {
    return 'Based on Aarav\'s site context, the SfN 2025 Drosophila poster describes a connectome-constrained brain model that predicts neural activity and controls behavior in a virtual environment. Aarav contributed to the embodiment component, coupling the neural model to a virtual fly body in a closed brain-body-environment loop.';
  }

  return '';
}

function shouldRequireWebSearch(messages) {
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage && lastMessage.content
    ? lastMessage.content.toLowerCase()
    : '';
  const searchTriggers = [
    'search the web',
    'web search',
    'look up',
    'google',
    'find online',
    'online',
    'latest',
    'recent',
    'current',
    'today',
    'now',
    'verify',
    'source',
    'sources',
    'cite',
    'citation',
    'link',
    'public page',
    'workshop page',
    'preprint page',
    'doi'
  ];

  return searchTriggers.some(function (trigger) {
    return text.indexOf(trigger) !== -1;
  });
}

function getPaperFileUrl(paperFile) {
  return PUBLIC_SITE_URL + paperFile.path;
}

function shouldAttachPaperFiles(messages) {
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage && lastMessage.content
    ? lastMessage.content.toLowerCase()
    : '';
  const paperTriggers = [
    'paper',
    'papers',
    'publication',
    'publications',
    'pdf',
    'poster',
    'method',
    'methods',
    'experiment',
    'experiments',
    'benchmark',
    'results',
    'figure',
    'figures',
    'mapshift',
    'ai scientists',
    'digital fly',
    'credit bandwidth',
    'odor plume',
    'drosophila',
    'sfn',
    'rlxf',
    'genbio'
  ];

  return paperTriggers.some(function (trigger) {
    return text.indexOf(trigger) !== -1;
  });
}

function getRelevantPaperFiles(messages) {
  const lastMessage = messages[messages.length - 1];
  const text = lastMessage && lastMessage.content
    ? lastMessage.content.toLowerCase()
    : '';
  const broadRequest = [
    'all',
    'each',
    'papers',
    'publications',
    'uploaded',
    'pdfs',
    'research'
  ].some(function (trigger) {
    return text.indexOf(trigger) !== -1;
  });
  const matchedPapers = PAPER_FILES.filter(function (paperFile) {
    return paperFile.aliases.some(function (alias) {
      return text.indexOf(alias) !== -1;
    });
  });

  if (matchedPapers.length > 0 && !broadRequest) {
    return matchedPapers.slice(0, MAX_PDF_ATTACHMENTS);
  }

  if (shouldAttachPaperFiles(messages)) {
    return PAPER_FILES.slice(0, MAX_PDF_ATTACHMENTS);
  }

  return [];
}

function buildResponsesInput(messages, attachedPaperFiles) {
  if (!attachedPaperFiles.length) {
    return messages;
  }

  return messages.map(function (message, index) {
    const isLastMessage = index === messages.length - 1;

    if (!isLastMessage || message.role !== 'user') {
      return message;
    }

    return {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: message.content + '\n\nAttached paper PDFs for this question: ' +
            attachedPaperFiles.map(function (paperFile) {
              return paperFile.title;
            }).join('; ') +
            '. Use the attached PDFs for paper-specific details before relying on summary context.'
        }
      ].concat(attachedPaperFiles.map(function (paperFile) {
        return {
          type: 'input_file',
          file_url: getPaperFileUrl(paperFile)
        };
      }))
    };
  });
}

function getMaxOutputTokens(model) {
  const configuredTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS);

  if (model.toLowerCase().startsWith('gpt-5')) {
    return Math.max(configuredTokens, GPT5_MIN_OUTPUT_TOKENS);
  }

  return configuredTokens;
}

function buildOpenAIRequestBody(messages) {
  const requireWebSearch = shouldRequireWebSearch(messages);
  const attachedPaperFiles = PDF_ACCESS_ENABLED ? getRelevantPaperFiles(messages) : [];
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const body = {
    model: model,
    instructions: SYSTEM_PROMPT,
    input: buildResponsesInput(messages, attachedPaperFiles),
    max_output_tokens: getMaxOutputTokens(model),
    store: false
  };

  if (!model.toLowerCase().startsWith('gpt-5')) {
    body.temperature = Number(process.env.OPENAI_TEMPERATURE || 0.3);
  }

  if (WEB_SEARCH_ENABLED) {
    body.tools = [
      {
        type: 'web_search',
        search_context_size: process.env.OPENAI_SEARCH_CONTEXT_SIZE || 'medium'
      }
    ];
    body.tool_choice = requireWebSearch ? 'required' : 'auto';
    body.include = ['web_search_call.action.sources'];
  }

  return body;
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
      body: JSON.stringify(buildOpenAIRequestBody(messages))
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

    const extractedCitations = extractCitations(responseBody);
    const blockedCitations = extractedCitations.filter(function (citation) {
      return isBlockedCitation(citation) || !isAllowedCitation(citation);
    });
    const citations = extractedCitations.filter(function (citation) {
      return !isBlockedCitation(citation) && isAllowedCitation(citation);
    });
    let reply = extractOutputText(responseBody);

    if (blockedCitations.length > 0) {
      reply = removeBlockedCitationText(reply, blockedCitations);

      if (citations.length === 0) {
        reply = getProfileFallbackForQuestion(lastMessage.content) || reply;
        reply += '\n\nI searched the web, but the only result returned was a secondary or aggregator source, so I am not treating it as an authoritative citation.';
      }
    }

    reply = formatReplyForUi(reply);

    sendJson(res, 200, {
      reply: reply || 'I could not generate an answer from the site context.',
      citations: citations
    });
  } catch (error) {
    sendJson(res, 500, { error: 'Network error while contacting the model.' });
  }
};
