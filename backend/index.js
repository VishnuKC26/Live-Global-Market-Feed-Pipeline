import express from 'express';
import cors from 'cors';
import RSSParser from 'rss-parser';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { GoogleDecoder } from 'google-news-url-decoder';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { OAuth2Client } from 'google-auth-library';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MongoDB connection
const mongoClient = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI) : null;
let usersCollection;

async function connectMongo() {
  if (!mongoClient) {
    console.warn('Warning: MONGODB_URI is not set. Running without MongoDB connection.');
    return;
  }
  try {
    await mongoClient.connect();
    const db = mongoClient.db('marketwire');
    usersCollection = db.collection('users');
    // Index on userId for fast lookups
    await usersCollection.createIndex({ userId: 1 }, { unique: true });
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    } else {
      console.warn('Warning: Continuing in development mode without MongoDB connection.');
    }
  }
}


const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const googleDecoder = new GoogleDecoder();
const decodedUrlCache = new Map();

// Concurrency-limited promise runner
async function pMap(items, mapper, concurrency = 5) {
  const results = [];
  let index = 0;
  
  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }
  
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  
  await Promise.all(workers);
  return results;
}

// Resolves a Google News URL to its original destination URL
async function resolveUrl(url) {
  if (!url) return url;
  if (!url.includes('news.google.com')) return url;
  
  if (decodedUrlCache.has(url)) {
    return decodedUrlCache.get(url);
  }
  
  try {
    const res = await googleDecoder.decode(url);
    if (res.status && res.decoded_url) {
      decodedUrlCache.set(url, res.decoded_url);
      return res.decoded_url;
    }
  } catch (err) {
    console.error(`Failed to decode URL ${url}:`, err.message);
  }
  
  return url; // fallback to original
}

const parser = new RSSParser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

// Configure the feeds to aggregate for each region based on Tiers 1, 2, and 3
const FEEDS = {
  global: [
    {
      name: 'Reuters Global Markets',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+("global+markets"+OR+"world+markets"+OR+"market+wrap"+OR+"morning+news+call"+OR+"evening+news+call"+OR+"week+ahead"+OR+"market+outlook"+OR+"daily+briefing")+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 1
    },
    {
      name: 'Financial Times Markets',
      url: 'https://news.google.com/rss/search?q=site:ft.com+(markets+OR+stocks+OR+bonds+OR+economy)+when:3d&hl=en-GB&gl=GB&ceid=GB:en',
      tier: 2
    },
    {
      name: 'Trading Economics',
      url: 'https://news.google.com/rss/search?q=site:tradingeconomics.com+(markets+OR+stocks+OR+bonds+OR+indicators)+when:3d&hl=en-GB&gl=GB&ceid=GB:en',
      tier: 2
    },
    {
      name: 'CNBC Markets',
      url: 'https://news.google.com/rss/search?q=site:cnbc.com+("global+markets"+OR+"market+wrap"+OR+"S%26P+500"+OR+Nasdaq+OR+"Dow+Jones"+OR+VIX)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 2
    }
  ],
  americas: [
    {
      name: 'Reuters Americas',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+("S%26P+500"+OR+Nasdaq+OR+Dow+OR+"Russell+2000"+OR+VIX+OR+"Wall+Street"+OR+"Treasury+yields"+OR+"US+stocks")+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 1
    },
    {
      name: 'Barron\'s',
      url: 'https://news.google.com/rss/search?q=site:barrons.com+(markets+OR+stocks+OR+bonds+OR+economy)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 2
    },
    {
      name: 'Trading Economics',
      url: 'https://news.google.com/rss/search?q=site:tradingeconomics.com+(markets+OR+stocks+OR+bonds+OR+indicators)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 2
    },
    {
      name: 'CNBC',
      url: 'https://news.google.com/rss/search?q=site:cnbc.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+"wall+street"+OR+"S%26P+500"+OR+Nasdaq+OR+"Dow+Jones"+OR+"Russell+2000"+OR+VIX)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 2
    },
    {
      name: 'MarketWatch',
      url: 'https://news.google.com/rss/search?q=site:marketwatch.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+"wall+street"+OR+"S%26P+500"+OR+Nasdaq+OR+"Dow+Jones"+OR+"Russell+2000"+OR+VIX)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 2
    },
    {
      name: 'Investing.com',
      url: 'https://news.google.com/rss/search?q=site:investing.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+"wall+street"+OR+"S%26P+500"+OR+Nasdaq+OR+"Dow+Jones"+OR+"Russell+2000"+OR+VIX)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 3
    },
    {
      name: 'Yahoo Finance',
      url: 'https://news.google.com/rss/search?q=site:finance.yahoo.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+"wall+street"+OR+"S%26P+500"+OR+Nasdaq+OR+"Dow+Jones"+OR+"Russell+2000"+OR+VIX)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 4
    }
  ],
  europe: [
    {
      name: 'Reuters Europe',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(DAX+OR+FTSE+OR+CAC+OR+"STOXX+600"+OR+"Euro+Stoxx"+OR+"European+stocks"+OR+"European+markets")+when:3d&hl=en-GB&gl=GB&ceid=GB:en',
      tier: 1
    },
    {
      name: 'Financial Times',
      url: 'https://news.google.com/rss/search?q=site:ft.com+(markets+OR+stocks+OR+bonds+OR+economy)+when:3d&hl=en-GB&gl=GB&ceid=GB:en',
      tier: 2
    },
    {
      name: 'Trading Economics',
      url: 'https://news.google.com/rss/search?q=site:tradingeconomics.com+(markets+OR+stocks+OR+bonds+OR+indicators)+when:3d&hl=en-GB&gl=GB&ceid=GB:en',
      tier: 2
    },
    {
      name: 'Euronews Business',
      url: 'https://news.google.com/rss/search?q=site:euronews.com/business+(markets+OR+stocks+OR+bonds+OR+economy)+when:3d&hl=en-GB&gl=GB&ceid=GB:en',
      tier: 2
    },
    {
      name: 'Investing.com',
      url: 'https://news.google.com/rss/search?q=site:investing.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+europe+OR+european+OR+DAX+OR+"FTSE+100"+OR+"CAC+40"+OR+"STOXX+600"+OR+"Euro+Stoxx+50"+OR+"FTSE+MIB"+OR+"IBEX+35"+OR+AEX)+when:3d&hl=en-GB&gl=GB&ceid=GB:en',
      tier: 3
    }
  ],
  mideast: [
    {
      name: 'Reuters Middle East',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+("Middle+East+markets"+OR+"Saudi+stocks"+OR+TASI+OR+"Dubai+stocks"+OR+"Qatar+stocks"+OR+"Israel+markets")+when:3d&hl=en-AE&gl=AE&ceid=AE:en',
      tier: 1
    },
    {
      name: 'CNBC Middle East',
      url: 'https://news.google.com/rss/search?q=site:cnbc.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+israel+OR+israeli+OR+"middle+east"+OR+mideast)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 2
    },
    {
      name: 'Investing Middle East',
      url: 'https://news.google.com/rss/search?q=site:investing.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+israel+OR+israeli+OR+"middle+east"+OR+mideast)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 3
    }
  ],
  asia: [
    {
      name: 'Reuters Asia',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(Nikkei+OR+TOPIX+OR+"Hang+Seng"+OR+"CSI+300"+OR+"Shanghai+Composite"+OR+Kospi+OR+Nifty+OR+Sensex+OR+"ASX+200"+OR+"Asian+stocks"+OR+"Asian+markets")+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 1
    },
    {
      name: 'Reuters India',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(India+stocks+OR+Nifty+OR+Sensex+OR+India+markets)+when:3d&hl=en-IN&gl=IN&ceid=IN:en',
      tier: 1
    },
    {
      name: 'Reuters Japan',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(Japan+stocks+OR+Nikkei+OR+TOPIX+OR+Japan+markets)+when:3d&hl=en-JP&gl=JP&ceid=JP:en',
      tier: 1
    },
    {
      name: 'Reuters China',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(China+OR+Chinese+OR+%22China+markets%22+OR+%22Chinese+stocks%22+OR+%22China+economy%22+OR+%22China+stimulus%22+OR+PBOC+OR+yuan+OR+renminbi+OR+Shanghai+Composite+OR+CSI+300+OR+Shenzhen+OR+mainland+OR+property+OR+%22property+sector%22+OR+%22Hong+Kong+stocks%22+OR+%22technology+shares%22+OR+%22consumer+stocks%22)+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 1
    },
    {
      name: 'Reuters Australia',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(Australia+stocks+OR+ASX+OR+Australia+markets)+when:3d&hl=en-AU&gl=AU&ceid=AU:en',
      tier: 1
    },
    {
      name: 'Reuters South Korea',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(Korea+stocks+OR+Kospi+OR+Korea+markets)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 1
    },
    {
      name: 'Reuters Taiwan',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(Taiwan+stocks+OR+Taiex+OR+Taiwan+markets)+when:3d&hl=en-US&gl=US&ceid=US:en',
      tier: 1
    },
    {
      name: 'Reuters Singapore',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(Singapore+stocks+OR+STI+OR+Singapore+markets)+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 1
    },
    {
      name: 'Reuters Hong Kong',
      url: 'https://news.google.com/rss/search?q=site:reuters.com+(Hong+Kong+stocks+OR+Hang+Seng+OR+Hong+Kong+markets)+when:3d&hl=en-HK&gl=HK&ceid=HK:en',
      tier: 1
    },
    {
      name: 'Nikkei Asia',
      url: 'https://news.google.com/rss/search?q=site:asia.nikkei.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+"Nikkei+225"+OR+TOPIX)+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 2
    },
    {
      name: 'South China Morning Post',
      url: 'https://news.google.com/rss/search?q=site:scmp.com+(markets+OR+stocks+OR+bonds+OR+economy)+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 2
    },
    {
      name: 'Caixin Global',
      url: 'https://news.google.com/rss/search?q=site:caixinglobal.com+(markets+OR+stocks+OR+economy)+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 2
    },
    {
      name: 'Business Standard',
      url: 'https://news.google.com/rss/search?q=site:business-standard.com+(markets+OR+stocks+OR+bonds+OR+economy)+when:3d&hl=en-IN&gl=IN&ceid=IN:en',
      tier: 2
    },
    {
      name: 'Moneycontrol',
      url: 'https://news.google.com/rss/search?q=site:moneycontrol.com+(markets+OR+stocks+OR+bonds+OR+economy)+when:3d&hl=en-IN&gl=IN&ceid=IN:en',
      tier: 2
    },
    {
      name: 'Investing.com',
      url: 'https://news.google.com/rss/search?q=site:investing.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+asia+OR+asian+OR+"Nikkei+225"+OR+TOPIX+OR+"Hang+Seng"+OR+"Shanghai+Composite"+OR+"CSI+300"+OR+Kospi+OR+"Nifty+50"+OR+Sensex+OR+"ASX+200")+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 3
    },
    {
      name: 'Yahoo Finance',
      url: 'https://news.google.com/rss/search?q=site:finance.yahoo.com+(stock+OR+stocks+OR+equity+OR+equities+OR+market+OR+markets+OR+share+OR+shares+OR+asia+OR+asian+OR+"Nikkei+225"+OR+TOPIX+OR+"Hang+Seng"+OR+"Shanghai+Composite"+OR+"CSI+300"+OR+Kospi+OR+"Nifty+50"+OR+Sensex+OR+"ASX+200")+when:3d&hl=en-SG&gl=SG&ceid=SG:en',
      tier: 4
    }
  ]
};


// Help helper to estimate reading time in minutes
function estimateReadTime(text) {
  if (!text) return 1;
  const words = text.trim().split(/\s+/).length;
  const wordsPerMinute = 200; 
  return Math.max(1, Math.ceil(words / wordsPerMinute));
}

// Clean title of unnecessary site suffixes
function cleanTitle(title, sourceName) {
  if (!title) return '';
  let cleaned = title
    .replace(/\s*-\s*CNBC$/i, '')
    .replace(/\s*\|\s*Reuters$/i, '')
    .replace(/\s*-\s*Yahoo Finance$/i, '')
    .replace(/\s*-\s*Investing\.com$/i, '')
    .replace(/\s*-\s*Bloomberg$/i, '')
    .trim();
  
  if (sourceName) {
    const escapedSourceName = sourceName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const sourceRegex = new RegExp(`\\s*-\\s*${escapedSourceName}$`, 'i');
    cleaned = cleaned.replace(sourceRegex, '').trim();
  }
  return cleaned;
}

// v2.0 - Relevance Filter Keywords
// ----------------------------
// RELEVANT MARKET TERMS
// ----------------------------

const RELEVANT_KEYWORDS = [
'stock',
'stocks',
'equity',
'equities',
'share',
'shares',
'market',
'markets',
'wall street',

's&p',
's&p 500',
'nasdaq',
'dow',
'russell 2000',
'vix',

'nikkei',
'topix',
'hang seng',
'kospi',
'shanghai',
'shenzhen',
'nifty',
'sensex',
'asx',

'dax',
'ftse',
'cac',
'stoxx',
'stoxx 600',
'euro stoxx',
'euro stoxx 50',
'shanghai composite',
'csi 300',
'ftse mib',
'ibex',
'aex',
'asx 200',
'tsx',
'bovespa',

'yield',
'yields',
'treasury',
'bond market',
'bond',
'bonds',

'fed',
'federal reserve',
'ecb',
'boj',
'pboc',
'rbi',

'inflation',
'cpi',
'ppi',
'payrolls',
'employment',
'jobs report',
'gdp',

'oil',
'crude',
'energy',

'dollar',
'yen',
'euro',
'currency',
'currencies',
'rate',
'rates',

'tariff',
'trade tensions',
'geopolitics',
'risk sentiment',
'risk appetite',
'risk-off',
'risk-on',
'global markets',
'world markets',
'market wrap',
'emerging markets',
'forex',
'commodities',
'morning news call',
'evening news call',
'week ahead',
'market outlook',
'daily briefing',
'pboc',
'yuan',
'renminbi',
'stimulus',
'property sector',
'local government debt'
];

// ----------------------------
// CORPORATE NOISE TERMS
// ----------------------------

const COMPANY_KEYWORDS = [
'earnings',
'quarterly results',
'revenue',
'profit',
'sales',
'guidance',
'analyst upgrade',
'analyst downgrade',
'price target',
'ipo',
'merger',
'acquisition',
'partnership',
'ceo',
'board of directors'
];

// ----------------------------
// ARTICLE FILTER
// ----------------------------

function isRelevant(item) {
const title = (item.title || '').toLowerCase();
const summary = (item.summary || '').toLowerCase();

const content = `${title} ${summary}`;

const marketRelated =
RELEVANT_KEYWORDS.some(keyword =>
content.includes(keyword)
);

if (!marketRelated) {
return false;
}

const corporateOnly =
COMPANY_KEYWORDS.some(keyword =>
content.includes(keyword)
);

if (corporateOnly) {


const marketContextTerms = [
  'stock',
  'stocks',
  'equity',
  'equities',
  'share',
  'shares',
  'market',
  'markets',
  'wall street',
  's&p',
  'nasdaq',
  'dow',
  'nikkei',
  'hang seng',
  'nifty',
  'dax',
  'yield',
  'fed',
  'inflation',
  'rate',
  'rates',
  'bond',
  'bonds',
  'index',
  'cpi',
  'gdp'
];

const hasMarketContext =
  marketContextTerms.some(keyword =>
    content.includes(keyword)
  );

if (!hasMarketContext) {
  return false;
}


}

return true;
}

// ----------------------------
// ARTICLE SCORING
// ----------------------------

// ----------------------------
// ARTICLE SCORING
// ----------------------------

function calculateScore(item, tier) {
  let score = 0;

  // Source quality
  if (tier === 1) score += 25;
  else if (tier === 2) score += 15;
  else score += 5;

  const title = (item.title || '').toLowerCase();
  const content = `${item.title || ''} ${item.summary || ''}`.toLowerCase();

  // Source Boosts
  if (item.source.includes('Reuters')) {
    score += 35;
  }
  if (item.source.includes('Financial Times') || item.source.includes('Financial Times Markets')) {
    score += 20;
  }
  if (item.source.includes('Trading Economics')) {
    score += 18;
  }
  if (item.source.includes('Nikkei') || item.source.includes('Nikkei Asia')) {
    score += 15;
  }
  if (item.source.includes('South China Morning Post') || item.source.includes('SCMP')) {
    score += 15;
  }
  if (item.source.includes('Caixin') || item.source.includes('Caixin Global')) {
    score += 15;
  }

  // Title-level Global/World Markets Boost
  if (title.includes('global markets') || title.includes('world markets')) {
    score += 40;
  }

  // Market Summary Boost
  const summaryKeywords = [
    'global markets',
    'world markets',
    'market wrap',
    'markets today',
    'morning news call',
    'evening news call',
    'week ahead',
    'market outlook',
    'daily briefing'
  ];
  if (summaryKeywords.some(k => content.includes(k))) {
    score += 50;
  }

  // China Macro Boost
  const chinaMacroKeywords = ['pboc', 'yuan', 'renminbi', 'china stimulus', 'chinese stimulus'];
  if (chinaMacroKeywords.some(k => content.includes(k))) {
    score += 20;
  }

  // China Headline Boost
  const chinaTitleKeywords = ['china markets', 'china economy', 'chinese markets', 'chinese economy'];
  if (chinaTitleKeywords.some(k => title.includes(k))) {
    score += 25;
  }

  // Central Bank Boost
  const centralBankKeywords = ['fed', 'federal reserve', 'ecb', 'boj', 'pboc', 'rbi'];
  if (centralBankKeywords.some(k => content.includes(k))) {
    score += 20;
  }

  // Bond Market Boost
  const bondKeywords = ['treasury', 'treasury yields', 'yields', 'bond market', 'bonds'];
  if (bondKeywords.some(k => content.includes(k))) {
    score += 15;
  }

  // Freshness boost
  const ageHours = (Date.now() - item.isoDate) / (1000 * 60 * 60);
  if (ageHours < 1) score += 30;
  else if (ageHours < 3) score += 25;
  else if (ageHours < 6) score += 20;
  else if (ageHours < 12) score += 10;
  else if (ageHours < 24) score += 5;

  // Penalize corporate stories
  if (
    content.includes('earnings') ||
    content.includes('ipo') ||
    content.includes('analyst upgrade') ||
    content.includes('analyst downgrade') ||
    content.includes('price target')
  ) {
    score -= 10;
  }

  return score;
}


async function fetchRegionFeeds(region) {
  const sources = FEEDS[region];

  if (!sources) {
    return {
      articles: []
    };
  }

  const feedPromises = sources.map(async (source) => {
    try {
      const response = await axios.get(source.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 8000
      });

      let cleanXml = response.data;

      if (typeof cleanXml === 'string') {
        cleanXml = cleanXml.replace(
          /&(?!([a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);)/g,
          '&amp;'
        );
      }

      const feed = await parser.parseString(cleanXml);

      const mapped = feed.items.map(item => {
        const titleClean = cleanTitle(item.title, source.name);
        const rawSummary = item.contentSnippet || item.content || '';
        const summaryClean = rawSummary.replace(/<[^>]*>/g, '').trim();

        // Standardize strings for redundancy check
        const compareTitle = titleClean.toLowerCase().replace(/[^a-z0-9]/g, '');
        const compareSummary = summaryClean.toLowerCase().replace(/[^a-z0-9]/g, '');

        let isRedundant = false;
        if (compareSummary === compareTitle) {
          isRedundant = true;
        } else if (compareSummary.startsWith(compareTitle)) {
          const extraPart = compareSummary.slice(compareTitle.length);
          if (extraPart.length < 30) {
            isRedundant = true;
          }
        } else if (compareTitle.startsWith(compareSummary)) {
          const extraPart = compareTitle.slice(compareSummary.length);
          if (extraPart.length < 30) {
            isRedundant = true;
          }
        }

        return {
          id: item.guid || item.link || item.title,
          title: titleClean,
          link: item.link,
          pubDate: item.pubDate || item.isoDate,
          isoDate: item.isoDate
            ? new Date(item.isoDate).getTime()
            : Date.now(),
          source: source.name,
          summary: isRedundant ? '' : rawSummary,
          category: item.categories ? item.categories[0] : null,
          tier: source.tier
        };
      });

      return mapped;

    } catch (error) {
      console.error(
        `Error fetching feed ${source.name}:`,
        error.message
      );

      return [];
    }
  });

  const results = await Promise.allSettled(feedPromises);

  let aggregated = [];

  results.forEach(result => {
    if (result.status === 'fulfilled') {
      aggregated = aggregated.concat(result.value);
    }
  });

  // Filter out articles older than 3 days
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const recentArticles = aggregated.filter(article => {
    return (Date.now() - article.isoDate) <= threeDaysMs;
  });

  // Apply relevance filter
  const relevantArticles = recentArticles.filter(isRelevant);

  // Score articles
  const scoredArticles = relevantArticles.map(article => ({
    ...article,
    score: calculateScore(article, article.tier)
  }));

  // Sort by score descending first
  scoredArticles.sort((a, b) => b.score - a.score);

  // Deduplicate by normalized title (retaining the first/highest-scoring occurrence)
  const seenTitles = new Set();
  const uniqueArticles = scoredArticles.filter(article => {
    if (!article.title) return false;
    const key = cleanTitle(article.title).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seenTitles.has(key)) {
      return false;
    }
    seenTitles.add(key);
    return true;
  });

  // Slice to top 60 (frontend only displays up to 60)
  const topArticles = uniqueArticles.slice(0, 60);

  return {
    articles: topArticles
  };
}

let cachedNewsData = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 3 * 60 * 1000; // 3 minutes cache duration
let activeFetchPromise = null;

async function performNewsFetch() {
  const [global, americas, europe, mideast, asia] = await Promise.all([
    fetchRegionFeeds('global'),
    fetchRegionFeeds('americas'),
    fetchRegionFeeds('europe'),
    fetchRegionFeeds('mideast'),
    fetchRegionFeeds('asia')
  ]);

  const data = {
    global: {
      regionName: 'GLOBAL MARKETS',
      articles: global.articles
    },
    americas: {
      regionName: 'AMERICAS',
      articles: americas.articles
    },
    europe: {
      regionName: 'EUROPE',
      articles: europe.articles
    },
    mideast: {
      regionName: 'MIDDLE EAST',
      articles: mideast.articles
    },
    asia: {
      regionName: 'ASIA PACIFIC',
      articles: asia.articles
    }
  };

  cachedNewsData = data;
  cacheTimestamp = Date.now();
  return data;
}

// Lightweight health check endpoint to prevent cold starts
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    timestamp: Date.now()
  });
});

// Endpoint to fetch news for all regions
app.get('/api/news', async (req, res) => {
  try {
    const now = Date.now();
    
    // If we have cached data and it's fresh, return it immediately
    if (cachedNewsData && (now - cacheTimestamp < CACHE_DURATION)) {
      return res.json({
        success: true,
        timestamp: cacheTimestamp,
        data: cachedNewsData,
        cached: true
      });
    }

    // If an active fetch is already in progress, wait for it
    if (activeFetchPromise) {
      const data = await activeFetchPromise;
      return res.json({
        success: true,
        timestamp: cacheTimestamp,
        data: data,
        cached: true
      });
    }

    // Otherwise, start a new fetch
    activeFetchPromise = performNewsFetch();
    const data = await activeFetchPromise;
    activeFetchPromise = null;

    res.json({
      success: true,
      timestamp: cacheTimestamp,
      data: data,
      cached: false
    });

  } catch (error) {
    activeFetchPromise = null;
    console.error('Failed to aggregate news feeds:', error);

    // If we have stale cache, return it as a fallback instead of failing
    if (cachedNewsData) {
      return res.json({
        success: true,
        timestamp: cacheTimestamp,
        data: cachedNewsData,
        stale: true,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to aggregate news feeds. Please try again.',
      error: error.message
    });
  }
});

// Endpoint to proxy full article page
app.get('/api/proxy', async (req, res) => {
  let { url } = req.query;
  
  if (!url) {
    return res.status(400).send('URL query parameter is required');
  }

  try {
    if (url.includes('news.google.com')) {
      url = await resolveUrl(url);
    }

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 10000
    });

    let html = response.data;
    const finalUrl = response.request.res.responseUrl || url;
    const origin = new URL(finalUrl).origin;

    if (html.includes('<head>')) {
      html = html.replace('<head>', `<head><base href="${origin}/">`);
    } else if (html.includes('<HEAD>')) {
      html = html.replace('<HEAD>', `<HEAD><base href="${origin}/">`);
    } else {
      html = `<base href="${origin}/">` + html;
    }

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error(`Failed to proxy URL ${url}:`, error.message);
    res.status(500).send('Proxy error');
  }
});

// Google Auth client ID verification helper
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
async function verifyGoogleToken(token) {
  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

// Helper to read user database (saved articles & notes)
async function readUserDb(userId) {
  try {
    const doc = await usersCollection.findOne({ userId });
    if (!doc) return { starred: {}, readLater: {}, notes: {} };
    return {
      starred: doc.starred || {},
      readLater: doc.readLater || {},
      notes: doc.notes || {}
    };
  } catch (err) {
    console.error(`Failed to read db for user ${userId}:`, err.message);
    return { starred: {}, readLater: {}, notes: {} };
  }
}

// Helper to write user database
async function writeUserDb(userId, data) {
  try {
    await usersCollection.replaceOne(
      { userId },
      { userId, starred: data.starred, readLater: data.readLater, notes: data.notes },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error(`Failed to write db for user ${userId}:`, err.message);
    return false;
  }
}

// ----------------------------
// AUTH & PERSISTENCE ENDPOINTS
// ----------------------------

// Endpoint to retrieve client config (e.g. Google Client ID) dynamically
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    googleClientId: process.env.GOOGLE_CLIENT_ID
  });
});

// Google Sign-In verification endpoint
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ success: false, message: 'Google credential token is required' });
  }

  try {
    const payload = await verifyGoogleToken(credential);
    const user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    };
    
    res.json({
      success: true,
      user
    });
  } catch (err) {
    console.error('Google verification error:', err.message);
    res.status(401).json({
      success: false,
      message: 'Failed to verify Google token. Check console logs for details.',
      error: err.message
    });
  }
});

// Developer Mock Login endpoint
app.post('/api/auth/mock', (req, res) => {
  const mockUser = {
    id: 'dev_user_123',
    email: 'dev@local.host',
    name: 'Developer User',
    picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c'
  };
  res.json({
    success: true,
    user: mockUser
  });
});

// Get user saved articles
app.get('/api/saved', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID header (X-User-Id) is required' });
  }
  
  const data = await readUserDb(userId);
  res.json({
    success: true,
    data: {
      starred: data.starred,
      readLater: data.readLater
    }
  });
});

// Save/update user saved articles
app.post('/api/saved', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { starred, readLater } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID header (X-User-Id) is required' });
  }
  
  const data = await readUserDb(userId);
  data.starred = starred || {};
  data.readLater = readLater || {};
  
  const success = await writeUserDb(userId, data);
  if (success) {
    res.json({ success: true, message: 'Saved successfully' });
  } else {
    res.status(500).json({ success: false, message: 'Failed to persist saved data' });
  }
});

// Get user notes
app.get('/api/notes', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID header (X-User-Id) is required' });
  }
  
  const data = await readUserDb(userId);
  res.json({
    success: true,
    notes: data.notes || {}
  });
});

// Save/update user notes
app.post('/api/notes', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { notes } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID header (X-User-Id) is required' });
  }
  
  const data = await readUserDb(userId);
  data.notes = notes || {};
  
  const success = await writeUserDb(userId, data);
  if (success) {
    res.json({ success: true, message: 'Notes saved successfully' });
  } else {
    res.status(500).json({ success: false, message: 'Failed to persist notes data' });
  }
});

// Serve static assets in production
const frontendDistPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDistPath));

// SPA routing fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(frontendDistPath, 'index.html'), (err) => {
    if (err) {
      next();
    }
  });
});

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`Market news feed backend is running on http://localhost:${PORT}`);
  });
});