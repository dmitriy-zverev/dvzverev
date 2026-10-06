// Quotes are curated from the linked texts. The model cannot edit attribution.
export const LITERARY_QUOTES = Object.freeze(
  [
    {
      id: 'crime-consciousness',
      text: 'Страдание и боль всегда обязательны для широкого сознания и глубокого сердца.',
      author: 'Фёдор Достоевский',
      work: 'Преступление и наказание',
      source:
        'https://ru.wikisource.org/wiki/Преступление_и_наказание_(Достоевский)/Часть_III/Глава_V',
    },
    {
      id: 'anna-families',
      text: 'Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.',
      author: 'Лев Толстой',
      work: 'Анна Каренина',
      source: 'https://ru.wikisource.org/wiki/Анна_Каренина_(Толстой)/Часть_I/Глава_I',
    },
    {
      id: 'alleys-memory',
      text: 'Все проходит, да не все забывается.',
      author: 'Иван Бунин',
      work: 'Тёмные аллеи',
      source: 'https://ru.wikisource.org/wiki/Тёмные_аллеи_(Бунин)',
    },
    {
      id: 'alleys-love',
      text: 'Молодость у всякого проходит, а любовь — другое дело.',
      author: 'Иван Бунин',
      work: 'Тёмные аллеи',
      source: 'https://ru.wikisource.org/wiki/Тёмные_аллеи_(Бунин)',
    },
    {
      id: 'karamazov-leaf',
      text: 'Каждый листик, каждый луч божий любите.',
      author: 'Фёдор Достоевский',
      work: 'Братья Карамазовы',
      source: 'https://ru.wikisource.org/wiki/Братья_Карамазовы_(Достоевский)/Книга_шестая',
    },
    {
      id: 'bears-love',
      text: 'Любовь тебя научит. Она строгая.',
      author: 'Лидия Зиновьева-Аннибал',
      work: 'Медвежата',
      source: 'https://ru.wikisource.org/wiki/Медвежата_(Зиновьева-Аннибал)/1907_(ВТ)',
    },
    {
      id: 'bears-strict',
      text: 'Чем любовь больше и святее, тем строже она.',
      author: 'Лидия Зиновьева-Аннибал',
      work: 'Медвежата',
      source: 'https://ru.wikisource.org/wiki/Медвежата_(Зиновьева-Аннибал)/1907_(ВТ)',
    },
    {
      id: 'bogomolov-faith',
      text: 'Из всех иллюзий жизни вера самая лучшая.',
      author: 'Максим Горький',
      work: 'Яков Богомолов',
      source: 'https://ru.wikisource.org/wiki/Яков_Богомолов_(Горький)',
    },
    {
      id: 'austen-hope',
      text: 'Я наполовину — мука, наполовину — надежда.',
      original: 'I am half agony, half hope.',
      author: 'Джейн Остин',
      work: 'Доводы рассудка',
      source: 'https://www.gutenberg.org/cache/epub/105/pg105-images.html',
      tradition: 'foreign',
      translation: 'перевод редакции',
    },
    {
      id: 'bronte-freedom',
      text: 'Я не птица, и никакая сеть меня не удержит.',
      original: 'I am no bird; and no net ensnares me',
      author: 'Шарлотта Бронте',
      work: 'Джейн Эйр',
      source: 'https://www.gutenberg.org/cache/epub/1260/pg1260-images.html',
      tradition: 'foreign',
      translation: 'перевод редакции',
    },
    {
      id: 'shelley-creature',
      text: 'Я должен был стать твоим Адамом, но я скорее падший ангел.',
      original: 'I ought to be thy Adam, but I am rather the fallen angel',
      author: 'Мэри Шелли',
      work: 'Франкенштейн',
      source: 'https://www.gutenberg.org/cache/epub/84/pg84-images.html',
      tradition: 'foreign',
      translation: 'перевод редакции',
    },
    {
      id: 'emily-kindred',
      text: 'Из чего бы ни состояли наши души, его душа и моя — из одного и того же.',
      original: 'Whatever our souls are made of, his and mine are the same',
      author: 'Эмили Бронте',
      work: 'Грозовой перевал',
      source: 'https://www.gutenberg.org/cache/epub/768/pg768-images.html',
      tradition: 'foreign',
      translation: 'перевод редакции',
    },
  ].map(Object.freeze),
);

export function literaryText(post) {
  const quote = LITERARY_QUOTES.find((item) => item.id === post?.quoteId);
  if (!quote || typeof post.id !== 'string' || !post.id || typeof post.commentary !== 'string')
    throw new Error('Invalid literary post');
  const text = post.commentary.trim();
  if (!text || /https?:|[#<>]|(?:^|\n)\s*(?:Автор:|Цитата:)/i.test(text))
    throw new Error('Invalid literary commentary');
  return `«${quote.text}»\n\n${quote.author} — «${quote.work}»${quote.translation ? ` (${quote.translation})` : ''}\n\n${text}`;
}

export function selectLiteraryQuote(history = []) {
  const last = LITERARY_QUOTES.find((item) => item.id === history.at(-1));
  const tradition = last?.tradition === 'foreign' ? 'russian' : last ? 'foreign' : 'russian';
  const candidates = LITERARY_QUOTES.filter((item) => (item.tradition || 'russian') === tradition);
  const recentWorks = history
    .slice(-4)
    .map((id) => LITERARY_QUOTES.find((item) => item.id === id)?.work);
  const recentAuthors = history
    .slice(-4)
    .map((id) => LITERARY_QUOTES.find((item) => item.id === id)?.author);
  return [...candidates].sort((a, b) => {
    const score = (item) => [
      Number(recentWorks.includes(item.work)),
      Number(recentAuthors.includes(item.author)),
      history.lastIndexOf(item.id),
    ];
    const left = score(a);
    const right = score(b);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  })[0];
}
