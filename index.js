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
    parent.parent.insertBefore(parent, rule)
  });
  parent.remove();
};

const isGroupNode = (node) => {
  return node.type == 'root' || (node.type == 'atrule' && node.name == 'mqgroup');
}

const isNestedMedia = (node) => {
  if (node.type != 'atrule' || atRule.name != 'media') {
    return false;
  }

  let parent = node.parent;

  while (parent)
  {
    if (parent.type == 'atrule' && parent.name == 'media') {
      return true;
    }

    parent = parent.parent;
  }

  return false;
}

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
    let _groupId = 1;

    // give root node an mqgrouper group id
    css._mqgrouperGroupId = _groupId;

    // place root group at the begining
    groups[_groupId] = {
      id: _groupId,
      node: css,
      type: 'root',
      queries: {},
      queryLists: []
    };

    // find '@media' rules
    css.walkAtRules('media', atRule => {
      // if (atRule.parent.parent && !isGroupNode(atRule.parent) && !isGroupNode(atRule.parent.parent)) {
      //   return;
      // }

      // get '@media' rule's group
      let parent = atRule.parent;
      let group;
      let distance = 0;

      // if in group -> up to 3 levels
      // else -> up to 2 levels

      // search for parent group, and handle nested @media rules
      while (parent)
      {
        distance++;

        // if parent is a '@mqgroup' node or 'root'
        if (isGroupNode(parent))
        {
          if (!group)
          {
            // set/get parent's mqgrouper group id
            parent._mqgrouperGroupId = parent._mqgrouperGroupId || ++_groupId;

            // initiliaze object representing the group
            group = {
              id: parent._mqgrouperGroupId,
              node: parent,
              type: parent.type
            };
          }

          else if (parent.type != 'root') {
            // throw nested groups error
            throw parent.error('nested `@mqgroup` rules are not supported');
          }
        }

        // wrap media query contents in other parent rules
        else if (distance === 1 && parent.type == 'atrule' && parent.name != 'media')
        {
          // - move @media child nodes to wrapper atrule (reproduces parent atruel)
          let wrapRule = postcss.atRule({
            name: parent.name,
            params: parent.params
          });

          atRule.each(node => {
            wrapRule.append(node);
          });

          // - add wrapper atrule as unique child to @media rule
          // atRule.remove();
          atRule.removeAll();
          atRule.append(wrapRule);
        }

        else {
          return;
        }

        parent = parent.parent;
      }

      if (!group) {
        group = groups[css._mqgrouperGroupId];
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

    // re-inject '@media' nodes, sorted and at the end of groups
    for (var groupId in groups)
    {
      let group = groups[groupId];

      // sort collected '@media' nodes in group
      sortQueryLists(group.queryLists, opts.sort).forEach(queryList => {
        // and add them at the end of the group's node
        group.node.append(group.queries[queryList]);
      });

      // replace '@mqgroup' nodes with their contents
      if (group.type == 'atrule') {
        unpackRules(group.node);
      }
    };

    // remove remaining @mqgroup queries (no nested @media)
    css.walkAtRules('mqgroup', (atRule) => {
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
