const _ = require('lodash');
const Helper = require('./helper.js');
const Discourse = require('./discourse');
const Promise = require('bluebird');
const config = require('config');

const DISCOURSE_SYSTEM_USERNAME = config.get('discourseSystemUsername');

// storing a reference to handle to userId lookup
// FIXME: (parth) this map will grow eventually as more users are added,
// consider using external cache instead
const handleMap = { system: 'system' };
handleMap[DISCOURSE_SYSTEM_USERNAME] = DISCOURSE_SYSTEM_USERNAME;

function Adapter(logger, db, _discourseClient = null) {// eslint-disable-line
  const helper = Helper(logger);
  const discourseClient = _discourseClient || new Discourse(logger);

  this.userIdLookup = function userIdLookup(handle) {
    return new Promise((resolve, reject) => { // eslint-disable-line
      if (handleMap[handle]) {
        resolve(handleMap[handle]);
      } else {
        return helper.getTopcoderUser(handle).then((result) => {
          if (result && result.userId) {
            handleMap[handle] = result.userId;
            resolve(result.userId);
          } else {
            resolve(null);
          }
        }).catch(() =>
      resolve(null));
      }
    });
  };

  function convertPost(input) {
    let userId = input.username;
    userId = userId !== 'system' && userId !== DISCOURSE_SYSTEM_USERNAME ? parseInt(userId, 10) : userId;
    return helper.mentionUserIdToHandle(input.cooked)
      .then(postBody => ({
        id: input.id,
        date: input.created_at,
        updatedDate: input.updated_at,
        userId,
        read: true,
        body: postBody,
        rawContent: input.raw,
        type: 'post',
      }));
  }

  this.adaptPosts = function a(input) {
    const result = [];

    return Promise.each(input.post_stream.posts,
      post => convertPost(post).then(cpost => result.push(cpost))).then(() => result);
  };

  this.adaptPost = function a(input) {
    return convertPost(input);
  };

  this.adaptTopic = function a(input) {
    const { topic, dbTopic } = input;
    return this.adaptTopics({ topics: [topic], dbTopics: [dbTopic] })
      .then(topics => (topics && topics.length > 0 ? topics[0] : topic));
  };

  this.adaptTopics = function a(input) {
    const topics = [];
    // console.log(input, 'input');
    let { topics: discourseTopics } = input;
    const pgTopics = input.dbTopics;
    if (!(discourseTopics instanceof Array)) {
      discourseTopics = [discourseTopics];
    }

    return Promise.each(discourseTopics, (discourseTopic) => {
      let userId = discourseTopic.post_stream.posts[0].username;
      userId = userId !== 'system' && userId !== DISCOURSE_SYSTEM_USERNAME ? parseInt(userId, 10) : userId;

      const pgTopic = _.find(pgTopics, pt => pt.discourseTopicId === discourseTopic.id);
      const topic = {
        id: discourseTopic.id,
        dbId: pgTopic ? pgTopic.id : undefined,
        reference: pgTopic ? pgTopic.reference : undefined,
        referenceId: pgTopic ? pgTopic.referenceId : undefined,
        date: discourseTopic.created_at,
        updatedDate: discourseTopic.updated_at,
        lastActivityAt: discourseTopic.created_at,
        title: discourseTopic.title,
        read: discourseTopic.post_stream.posts[0].read,
        userId,
        tag: discourseTopic.tag,
        totalPosts: discourseTopic.post_stream.stream.length,
        retrievedPosts: discourseTopic.post_stream.posts.length,
        postIds: discourseTopic.post_stream.stream,
        posts: [],
      };
      return discourseClient.getPosts(DISCOURSE_SYSTEM_USERNAME, discourseTopic.id, topic.postIds).then(posts => (
        Promise.each(posts.data.post_stream.posts,
          discoursePost => helper.mentionUserIdToHandle(discoursePost.cooked)
          .then((postBody) => {
            let userId = discoursePost.username; //eslint-disable-line
            userId = userId !== 'system' && userId !== DISCOURSE_SYSTEM_USERNAME ? parseInt(userId, 10) : userId;
            // ignore createdAt for invited_user type posts
            if (['invited_user', 'removed_user', 'user_left'].indexOf(discoursePost.action_code) === -1
              && discoursePost.updated_at > topic.lastActivityAt) {
              topic.lastActivityAt = discoursePost.updated_at;
            }
            if (discoursePost.action_code === 'invited_user' && discoursePost.action_code_who) {
              topic.retrievedPosts -= 1;
              topic.posts.push({
                id: discoursePost.id,
                date: discoursePost.created_at,
                userId,
                read: true,
                body: `${discoursePost.action_code_who} joined the discussion`,
                type: 'user-joined',
              });
            } else if (['removed_user', 'user_left'].indexOf(discoursePost.action_code) !== -1
              && discoursePost.action_code_who) {
              topic.retrievedPosts -= 1;
              topic.posts.push({
                id: discoursePost.id,
                date: discoursePost.created_at,
                userId,
                read: true,
                body: `${discoursePost.action_code_who} unfollowed the discussion`,
                type: 'user-removed',
              });
            } else {
              topic.posts.push({
                id: discoursePost.id,
                date: discoursePost.created_at,
                updatedDate: discoursePost.updated_at,
                userId,
                read: discoursePost.read,
                body: postBody,
                rawContent: discoursePost.raw,
                type: 'post',
              });
            }
          })//eslint-disable-line
        ).then(() => {
          topics.push(topic);
        })
      ));
    }).then(() => topics);
  };

  return this;
}

module.exports = Adapter;
