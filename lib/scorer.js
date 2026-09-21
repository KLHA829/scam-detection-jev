'use strict';

const { JevlikeClient } = require('./jevlike-client');

function createScoreClient(env = process.env, extras = {}) {
  return new JevlikeClient({ env, ...extras });
}

function scoreArchiveReason(scoreResult) {
  if (scoreResult && scoreResult.archiveReason) return scoreResult.archiveReason;
  return 'jevlike_score';
}

module.exports = {
  createScoreClient,
  scoreArchiveReason,
};
