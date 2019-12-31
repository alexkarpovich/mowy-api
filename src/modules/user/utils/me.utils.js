const { driver } = require('../../../settings/neo4j');

module.exports = async function me(uid) {
  const session = driver.session();

  try {
    const { records } = await session.run(`
    MATCH (user:User) WHERE user.id=$uid RETURN user
  `, { uid });

    return records[0].get('user').properties;
  } catch(err) {
    throw err
  } finally {
    session.close();
  }
}
