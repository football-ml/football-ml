'use strict';

const util = require('util');

const commander = require('commander');
const logger = require('winston');
const lodash = require('lodash');

const co = require('co');

const DataProcessor = require('./src/data-processor');
const DataPool = require('./src/data-pool');
logger.cli();

function toInt(year) {
  return parseInt(year, 10);
}

function list(excludes) {
  return excludes.split(';');
}

commander
  .option('-y, --year [n]', 'The year of the season start in YY, i.e. 14 [default=15]', toInt, 16)
  .option('-c, --countrycode [s]', 'The country code, i.e. de, es, en, it [default=de]', 'de')
  .option('-l, --league [s]', 'The league, i.e. 1 for Premier League, Serie A, 1. Bundesliga,.. [default=1]', '1')
  .option('-e, --exclude [s]', 'Excludes a certain attribute from the generated CSV, i.e. "form_delta_last_3;team_h_form_last_5" [default=[]]', list, [])
  .option('-m, --minmatches [n]', 'The minimum number of matches that have to be played before a match is considered for the training data [default=5]', toInt, 5)
  .option('-M, --clubmeta [b]', 'NOTE: Currently only supported for (de,15,1). Crawls club meta data (marketValue..) and adds it to the data set. Decreases processing speed [default=false]', false)
  .option('-L, --local [b]', 'Use local data instead of github etc. [default=false]', false)
  .option('-F, --full [b]', 'Creates a csv with all data in addition to separate test and trainings sets. [default=false]', false)
  .option('-C, --complete [b]', 'Also adds yet unplayed matches to the CSV. [default=false]', false)
  .option('-V, --verbose [b]', 'Also adds verbose data like team code that makes reading data easier for humans. [default=false]', false)
  .option('-T, --tables [b]', 'Print tables. [default=false]', false)
  .parse(process.argv);

const exporterConfig = {
  verbose: commander.verbose,
  exclude: commander.exclude,
  minmatches: commander.minmatches,
  clubmeta: commander.clubmeta,
  full: commander.full,
  complete: commander.complete,
  tables: commander.tables
};

const dataPoolConfig = {
  league: commander.league,
  country: commander.countrycode,
  year: commander.year
};

logger.info('Behaviour Config is', exporterConfig);
logger.info('DataPool Config is', dataPoolConfig);
logger.warn('The first %s matchdays will be ignored in training data due to --minmatches setting', exporterConfig.minmatches);

const start = Date.now();
co(function *() {
  const datapool = new DataPool(dataPoolConfig);
  const fixturesData = yield datapool.loadClubAndMatchData(commander.local);
  const lastPlayedRound = DataProcessor.lastCompletelyFinishedRound(fixturesData.rounds);
  const predictedRound = lastPlayedRound + 1;

  logger.info('Got league fixtures, clubs and results from %s', commander.local ? 'Local File' : 'github.com/openfootball/football.json');
  logger.info('Last completely played game day is %s', lastPlayedRound);

  const clubCodes = DataPool.toClubCodes(fixturesData.clubs);

  let clubMeta = {};

  // Optional until all transfermarkt.de id mappings are created. Currently only for (de, 1, 2015)
  if (exporterConfig.clubmeta) {
    clubMeta = yield datapool.loadClubMeta(clubCodes);
    logger.info('Got club metadata from transfermarkt.de for %s clubs', Object.keys(clubMeta).length);
  }

  const roundMeta = yield datapool.loadRoundMeta(exporterConfig.minmatches, predictedRound);
  logger.info('Got round metadata from transfermarkt.de for %s - %s = %s rounds', predictedRound, exporterConfig.minmatches - 1, Object.keys(roundMeta).length);

  const dataProcessor = new DataProcessor(fixturesData.clubs, fixturesData.rounds, clubMeta, roundMeta, lastPlayedRound, exporterConfig);

  const data = dataProcessor.makeData();

  const trainDataPath = yield datapool.writeTrainingDataToDiskAsCSV(data.trainingData);
  const testDataPath = yield datapool.writeTestDataToDiskAsCSV(data.testData);

  if (exporterConfig.full) {
    yield datapool.writeFullDataToDiskAsCSV(data.trainingData, data.testData);
  }

  const allData = Object.keys(data.trainingData);
  const columnNames = Object.keys(data.trainingData[0]);

  logger.info('Training Data: Processed %s matches for %s', allData.length, datapool.yearSeasonLeague);
  logger.info('Training Data: Calculated %s attributes:\n %s', columnNames.length, columnNames);
  logger.info('Training Data: %s data points calculated', allData.length * columnNames.length);
  logger.info('Saved training data set to %s', trainDataPath);
  logger.info('Saved test data set to %s', testDataPath);
  logger.info(`Export took ${Date.now() - start} ms`);

  const predictedRoundData = fixturesData.rounds[predictedRound - 1];

  if (predictedRoundData) {
    logger.info('Predicted games are %s', lodash.map(predictedRoundData.matches, (m, i) => util.format('[%s] %s : %s', i + 1, m.team1.code, m.team2.code)));
  } else {
    logger.warn('No games found to be predicted. This is expected if the season is over, otherwise indicates an error')
  }

  return data;
}).then(() => {
  process.exit(0);
}).catch((err) => {
  logger.error(err.message);
  process.exit(0);
});
