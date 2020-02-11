const { chunk, shuffle } = require('lodash');
const { TYPE_CYCLES } = require('./constant.util');
const BaseBuilder = require('./base-builder.util');

const MIN_CHUNK_SIZE = 7;

class CyclesBuilder extends BaseBuilder {
  constructor(driver, setIds) {
    super(driver, TYPE_CYCLES, setIds);
  }

  async countTranslations(session, trainingId) {
    const { records } = await session.run(`
        MATCH (train:Training{id: $trainingId})-[:INCLUDES]->(s:Set)-[:INCLUDE]->(trans:Translation)
        RETURN COUNT(DISTINCT trans) as count
      `, { trainingId });

    return +records[0].get('count');
  }

  async getTranslationIds(session, trainingId) {
    const { records } = await session.run(`
      MATCH (train:Training{id: $trainingId})-[:INCLUDES]->(s:Set)-[:INCLUDES]->(trans:Translation)
      RETURN DISTINCT trans.id as id
    `, { trainingId });

    return records.map(rec => rec.get('id'));
  }

  async buildStages(session, trainingId, stages) {
    const { records } = await session.run(`
      MATCH (train:Training{id: $trainingId}), (active:Active)
      UNWIND range(0, size($stages)-1) as sid
      WITH train, active, $stages[sid] as cycles, sid
      MERGE (train)-[:INCLUDES]->(stage:Stage{id: sid+1})
        ON CREATE SET stage.prev = CASE sid WHEN 0 THEN [] ELSE [sid] END,
          stage.active = CASE sid WHEN 0 THEN [1] ELSE [] END
      FOREACH(i IN stage.active |
        MERGE (active)-[:INCLUDES]->(stage)
      )
      REMOVE stage.prev
      REMOVE stage.active
      WITH active, sid, stage, cycles
      UNWIND range(0, size(cycles)-1) as cid
      WITH active, sid, stage, cid, cycles[cid] as translations
      MERGE (stage)-[:INCLUDES]->(cycle:Cycle{id: cid+1})
        ON CREATE SET cycle.active = CASE sid+cid WHEN 0 THEN [1] ELSE [] END
      FOREACH(i IN cycle.active |
        MERGE (active)-[:INCLUDES]->(cycle)
      )
      REMOVE cycle.active
      WITH cycle, translations
      UNWIND translations as transId
      MATCH (trans:Translation{id: transId})
      MERGE (cycle)-[:INCLUDES]->(trans)
    `, { trainingId, stages });

    return records.map(rec => rec.get('id'));
  }

  async build() {
    const session = this.driver.session();
    let training = await this.matchExisting(session);

    if (training) {
      return training;
    }

    return session.readTransaction(async (txc) => {
      training = await this.assignSets(txc);
      const transIds = await this.getTranslationIds(txc, training.id);
      const count = transIds.length;
      const stageCount = Math.round(Math.log(count * 1. / MIN_CHUNK_SIZE) / Math.log(2)) + 1;
      let stages = Array.from(Array(stageCount).keys());

      let ids, chunkSize, rate;

      stages = stages.map((k) => {
        ids = shuffle(transIds);
        rate = Math.round(count / (MIN_CHUNK_SIZE * Math.pow(2, k)));
        chunkSize = Math.round(count / rate);

        return chunk(ids, chunkSize);
      });

      console.log(count, stages.map(cycles => cycles.length));

      await this.buildStages(txc, training.id, stages);

      return training;
    }).catch(e => console.log(e))
      .finally(() => session.close());
  }
}

module.exports = CyclesBuilder;