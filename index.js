'use strict';

const list = require("postcss/lib/list");
const pkg = require("./package.json");
const postcss = require("postcss");

const isSourceMapAnnotation = rule => {
  if (!rule) {
    return false;
  }

  if (rule.type !== "comment") {
    return false;
  }

  if (rule.text.toLowerCase().indexOf("# sourcemappingurl=") !== 0) {
    return false;
  }

  return true;
};

const parseQueryList = queryList => {
  const queries = [];

  list.comma(queryList).forEach(query => {
    const expressions = {};

    list.space(query).forEach(expression => {
      let newExpression = expression.toLowerCase();

      if (newExpression === "and") {
        return;
      }

      if (/^\w+$/.test(newExpression)) {
        expressions[newExpression] = true;

        return;
      }

      newExpression = list.split(newExpression.replace(/^\(|\)$/g, ""), [":"]);
      const [feature, value] = newExpression;

      if (!expressions[feature]) {
        expressions[feature] = [];
      }

      expressions[feature].push(value);
    });
    queries.push(expressions);
  });

  return queries;
};

const inspectLength = length => {
  if (length === "0") {
    return 0;
  }

  const matches = /(-?\d*\.?\d+)(ch|em|ex|px|rem)/.exec(length);

  if (!matches) {
    return Number.MAX_VALUE;
  }

  matches.shift();
  const [num, unit] = matches;
  let newNum = num;

  switch (unit) {
    case "ch":
      newNum = parseFloat(newNum) * 8.8984375;

      break;

    case "em":
    case "rem":
      newNum = parseFloat(newNum) * 16;

      break;

    case "ex":
      newNum = parseFloat(newNum) * 8.296875;

      break;

    case "px":
      newNum = parseFloat(newNum);

      break;
  }

  return newNum;
};

const pickMinimumMinWidth = expressions => {
  const minWidths = [];

  expressions.forEach(feature => {
    let minWidth = feature["min-width"];

    if (!minWidth || feature.not || feature.print) {
      minWidth = [null];
    }

    minWidths.push(minWidth.map(inspectLength).sort((a, b) => b - a)[0]);
  });

  return minWidths.sort((a, b) => a - b)[0];
};

const sortQueryLists = (queryLists, sort) => {
  const mapQueryLists = [];

  if (!sort) {
    return queryLists;
  }

  if (typeof sort === "function") {
    return queryLists.sort(sort);
  }

  queryLists.forEach(queryList => {
    mapQueryLists.push(parseQueryList(queryList));
  });

  return mapQueryLists
    .map((e, i) => ({
      index: i,
      value: pickMinimumMinWidth(e)
    }))
    .sort((a, b) => a.value - b.value)
    .map(e => queryLists[e.index]);
};

const unpackRules = (parent) => {
  parent.each(rule => {
    rule.moveBefore(parent);
  });

  parent.remove();
};

module.exports = postcss.plugin(pkg.name, options => {
  const opts = {
    sort: false,
    ...options
  };

  return css => {
    // get source-map annotation
    let sourceMap = css.last;

    if (!isSourceMapAnnotation(sourceMap)) {
      sourceMap = null;
    }

    const groups = {};
    let _groupId = 0;

    // give root node an mqpacker group id
    css._mqpackerGroupId = _groupId;

    // find '@media' rules
    css.walkAtRules('media', atRule => {
      // get '@media' rule's group
      let _searchForGroup = true,
        parent = atRule.parent,
        // default to root group
        group = {
          id: 0,
          type: 'root',
          node: css
        };

      // search for '@mqpack' rule in ancestors
      while (_searchForGroup && parent)
      {
        // if '@media' rule is nested in a '@mqpack' rule
        if (parent.type == 'atrule' && parent.name == 'mqpack')
        {
          // set/get parent's mqpacker group id
          parent._mqpackerGroupId = parent._mqpackerGroupId || ++_groupId;

          // set the '@media' group attributes to represent the '@mqpack' node
          group = {
            id: parent._mqpackerGroupId,
            node: parent,
            type: 'mqpack'
          };

          _searchForGroup == false;
        }

        // check ancestor one level up
        parent = parent.parent;
      }

      // register new '@media' query groups
      if (!groups.hasOwnProperty(group.id))
      {
        group.queries = {};
        group.queryLists = [];
        groups[group.id] = group;
      }

      const queryList = atRule.params;
      const past = groups[group.id].queries[queryList];

      // if another '@media' with same params was already found
      if (typeof past === "object") {
        // add rules from this '@media' to the one found before
        atRule.each(rule => {
          past.append(rule.clone());
        });
      } else {
        // clone current '@media' and register for further processing
        groups[group.id].queries[queryList] = atRule.clone();
        groups[group.id].queryLists.push(queryList);
      }

      // remove '@media' node
      atRule.remove();
    });

    // re-inject '@media' nodes in-place
    for (var groupId in groups)
    {
      let group = groups[groupId];      

      // sort collected '@media' nodes in group
      sortQueryLists(group.queryLists, opts.sort).forEach(queryList => {
        // and add them at the end of the group's node
        group.node.append(group.queries[queryList]);
      });

      // replace '@mqpack' nodes with their contents
      if (group.type == 'mqpack') {
        unpackRules(group.node);
      }
    };

    // remove remaining @mqpack queries (no nested @media)
    css.walkAtRules('mqpack', (atRule) => {
      unpackRules(atRule);
    });

    // move source-map annotation to the end
    if (sourceMap) {
      css.append(sourceMap);
    }
    // return resulting css tree
    return css;
  };
});

module.exports.pack = function (css, opts) {
  return postcss([this(opts)]).process(css, opts);
};
