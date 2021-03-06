"use strict";

var $ = require("../../core/renderer"),
    toComparable = require("../../core/utils/data").toComparable,
    dataUtils = require("../../data/utils"),
    each = require("../../core/utils/iterator").each,
    extend = require("../../core/utils/extend").extend,
    storeHelper = require("../../data/store_helper"),
    gridCore = require("./ui.data_grid.core"),
    normalizeSortingInfo = gridCore.normalizeSortingInfo,
    groupingCore = require("./ui.data_grid.grouping.core"),
    createGroupFilter = groupingCore.createGroupFilter,
    createOffsetFilter = groupingCore.createOffsetFilter,
    dataQuery = require("../../data/query"),
    when = require("../../integration/jquery/deferred").when;

var loadTotalCount = function(dataSource, options) {
    var d = $.Deferred(),
        loadOptions = extend({ skip: 0, take: 1, requireTotalCount: true }, options);

    dataSource.load(loadOptions).done(function(data, extra) {
        d.resolve(extra && extra.totalCount);
    }).fail(d.reject.bind(d));
    return d;
};

///#DEBUG
exports.loadTotalCount = loadTotalCount;
///#ENDDEBUG

exports.GroupingHelper = groupingCore.GroupingHelper.inherit((function() {

    var foreachCollapsedGroups = function(that, callback, updateOffsets) {
        return that.foreachGroups(function(groupInfo) {
            if(!groupInfo.isExpanded) {
                return callback(groupInfo);
            }
        }, false, false, updateOffsets, true);
    };

    var correctSkipLoadOption = function(that, skip) {
        var skipCorrection = 0,
            resultSkip = skip || 0;

        if(skip) {
            foreachCollapsedGroups(that, function(groupInfo) {
                if(groupInfo.offset - skipCorrection >= skip) {
                    return false;
                }
                skipCorrection += groupInfo.count - 1;
            });
            resultSkip += skipCorrection;
        }
        return resultSkip;
    };

    var processGroupItems = function(that, items, path, offset, skipFirstItem, take) {
        var i,
            item,
            offsetInfo,
            removeLastItemsCount = 0,
            needRemoveFirstItem = false;

        for(i = 0; i < items.length; i++) {
            item = items[i];
            if(item.items !== undefined) {
                path.push(item.key);
                var groupInfo = that.findGroupInfo(path);

                if(groupInfo && !groupInfo.isExpanded) {
                    item.collapsedItems = item.items;
                    item.items = null;
                    offset += groupInfo.count;
                    take--;
                    if(take < 0) {
                        removeLastItemsCount++;
                    }
                    if(skipFirstItem) {
                        needRemoveFirstItem = true;
                    }
                } else if(item.items) {
                    offsetInfo = processGroupItems(that, item.items, path, offset, skipFirstItem, take);
                    if(skipFirstItem) {
                        if(offsetInfo.offset - offset > 1) {
                            item.isContinuation = true;
                        } else {
                            needRemoveFirstItem = true;
                        }
                    }
                    offset = offsetInfo.offset;
                    take = offsetInfo.take;
                    if(take < 0) {
                        if(item.items.length) {
                            item.isContinuationOnNextPage = true;
                        } else {
                            removeLastItemsCount++;
                        }
                    }
                }
                path.pop();
            } else {
                if(skipFirstItem) {
                    needRemoveFirstItem = true;
                }
                offset++;
                take--;
                if(take < 0) {
                    removeLastItemsCount++;
                }

            }
            skipFirstItem = false;
        }
        if(needRemoveFirstItem) {
            items.splice(0, 1);
        }
        if(removeLastItemsCount) {
            items.splice(-removeLastItemsCount, removeLastItemsCount);
        }
        return {
            offset: offset,
            take: take
        };
    };

    var pathEquals = function(path1, path2) {
        var i;
        if(path1.length !== path2.length) return false;
        for(i = 0; i < path1.length; i++) {
            if(!dataUtils.keysEqual(null, path1[i], path2[i])) {
                return false;
            }
        }
        return true;
    };

    var updateGroupOffsets = function(that, items, path, offset, additionalGroupInfo) {
        var i,
            item;

        if(!items) return;

        for(i = 0; i < items.length; i++) {
            item = items[i];
            if("key" in item && item.items !== undefined) {
                path.push(item.key);
                if(additionalGroupInfo && pathEquals(additionalGroupInfo.path, path) && !item.isContinuation) {
                    additionalGroupInfo.offset = offset;
                }
                var groupInfo = that.findGroupInfo(path);
                if(groupInfo && !item.isContinuation) {
                    groupInfo.offset = offset;
                }
                if(groupInfo && !groupInfo.isExpanded) {
                    offset += groupInfo.count;
                } else {
                    offset = updateGroupOffsets(that, item.items, path, offset, additionalGroupInfo);
                }
                path.pop();
            } else {
                offset++;
            }
        }
        return offset;
    };

    var removeGroupLoadOption = function(storeLoadOptions, loadOptions) {
        var groups,
            sorts;

        if(loadOptions.group) {
            groups = normalizeSortingInfo(loadOptions.group);
            sorts = normalizeSortingInfo(storeLoadOptions.sort);
            storeLoadOptions.sort = storeHelper.arrangeSortingInfo(groups, sorts);
            delete loadOptions.group;
        }
    };

    var createNotGroupFilter = function(path, storeLoadOptions, group) {
        var groups = normalizeSortingInfo(group || storeLoadOptions.group),
            i,
            j,
            filterElement,
            filter = [];

        for(i = 0; i < path.length; i++) {
            filterElement = [];
            for(j = 0; j <= i; j++) {
                filterElement.push([groups[j].selector, i === j ? "<>" : "=", path[j]]);
            }
            filter.push(gridCore.combineFilters(filterElement));
        }
        filter = gridCore.combineFilters(filter, "or");

        return gridCore.combineFilters([filter, storeLoadOptions.filter]);
    };

    var getGroupCount = function(item, groupCount) {
        var count = item.count || item.items.length,
            i;

        if(!item.count && groupCount > 1) {
            count = 0;
            for(i = 0; i < item.items.length; i++) {
                count += getGroupCount(item.items[i], groupCount - 1);
            }
        }

        return count;
    };

    return {
        handleDataLoading: function(options) {
            var that = this,
                storeLoadOptions = options.storeLoadOptions,
                loadOptions,
                collapsedGroups = [],
                collapsedItemsCount = 0,
                skipFirstItem = false,
                take,
                group = options.loadOptions.group,
                skipCorrection = 0;

            removeGroupLoadOption(storeLoadOptions, options.loadOptions);

            options.group = options.group || group;

            if(options.isCustomLoading) {
                return;
            }

            loadOptions = extend({}, storeLoadOptions);

            loadOptions.skip = correctSkipLoadOption(that, storeLoadOptions.skip);

            if(loadOptions.skip && loadOptions.take && group) {
                loadOptions.skip--;
                loadOptions.take++;
                skipFirstItem = true;
            }

            if(loadOptions.take && group) {
                take = loadOptions.take;
                loadOptions.take++;
            }

            foreachCollapsedGroups(that, function(groupInfo) {
                if(groupInfo.offset >= loadOptions.skip + loadOptions.take + skipCorrection) {
                    return false;
                } else if(groupInfo.offset >= loadOptions.skip + skipCorrection && groupInfo.count) {
                    skipCorrection += groupInfo.count - 1;
                    collapsedGroups.push(groupInfo);
                    collapsedItemsCount += groupInfo.count;
                }
            });

            each(collapsedGroups, function() {
                loadOptions.filter = createNotGroupFilter(this.path, loadOptions, group);
            });

            options.storeLoadOptions = loadOptions;
            options.collapsedGroups = collapsedGroups;
            options.collapsedItemsCount = collapsedItemsCount;
            options.skip = loadOptions.skip || 0;
            options.skipFirstItem = skipFirstItem;
            options.take = take;
        },
        handleDataLoaded: function(options, callBase) {
            var that = this,
                data = options.data,
                pathIndex,
                query,
                collapsedGroups = options.collapsedGroups,
                groups = normalizeSortingInfo(options.group),
                groupCount = groups.length;

            function appendCollapsedPath(data, path, groups, collapsedGroup, offset) {
                if(!data || !path.length || !groups.length) return;

                var i,
                    keyValue,
                    pathValue = toComparable(path[0], true);

                for(i = 0; i < data.length; i++) {
                    keyValue = toComparable(data[i].key, true);
                    if(offset >= collapsedGroup.offset || pathValue === keyValue) {
                        break;
                    } else {
                        offset += getGroupCount(data[i], groups.length);
                    }
                }

                if(!data.length || pathValue !== keyValue) {
                    data.splice(i, 0, { key: path[0], items: [], count: path.length === 1 ? collapsedGroup.count : undefined });
                }
                appendCollapsedPath(data[i].items, path.slice(1), groups.slice(1), collapsedGroup, offset);
            }

            callBase(options);

            if(groupCount) {
                query = dataQuery(data);
                storeHelper.multiLevelGroup(query, groups).enumerate().done(function(groupedData) {
                    data = groupedData;
                });
                if(collapsedGroups) {
                    for(pathIndex = 0; pathIndex < collapsedGroups.length; pathIndex++) {
                        appendCollapsedPath(data, collapsedGroups[pathIndex].path, groups, collapsedGroups[pathIndex], options.skip);
                    }
                }
                if(!options.isCustomLoading) {
                    processGroupItems(that, data, [], options.skip, options.skipFirstItem, options.take);
                    that.updateItemsCount(data, groupCount);
                }
                options.data = data;
                if(options.collapsedItemsCount && options.extra && options.extra.totalCount >= 0) {
                    options.extra.totalCount += options.collapsedItemsCount;
                }
            }
        },
        updateTotalItemsCount: function() {
            var itemsCountCorrection = 0;

            foreachCollapsedGroups(this, function(groupInfo) {
                if(groupInfo.count) {
                    itemsCountCorrection -= groupInfo.count - 1;
                }
            });
            this.callBase(itemsCountCorrection);
        },
        changeRowExpand: function(path) {
            var that = this,
                dataSource = that._dataSource,
                beginPageIndex = dataSource.beginPageIndex ? dataSource.beginPageIndex() : dataSource.pageIndex(),
                dataSourceItems = dataSource.items(),
                offset = correctSkipLoadOption(that, beginPageIndex * dataSource.pageSize()),
                groupInfo = that.findGroupInfo(path),
                groupCountQuery;

            if(groupInfo && !groupInfo.isExpanded) {
                groupCountQuery = $.Deferred().resolve(groupInfo.count);
            } else {
                groupCountQuery = loadTotalCount(dataSource, {
                    filter: createGroupFilter(path, {
                        filter: dataSource.filter(),
                        group: dataSource.group()
                    })
                });
            }

            return when(groupCountQuery).done(function(count) {
                count = parseInt(count.length ? count[0] : count);
                if(groupInfo) {
                    updateGroupOffsets(that, dataSourceItems, [], offset);
                    groupInfo.isExpanded = !groupInfo.isExpanded;
                    groupInfo.count = count;
                } else {
                    groupInfo = {
                        offset: -1,
                        count: count,
                        path: path,
                        isExpanded: false
                    };
                    updateGroupOffsets(that, dataSourceItems, [], offset, groupInfo);
                    if(groupInfo.offset >= 0) {
                        that.addGroupInfo(groupInfo);
                    }
                }
                that.updateTotalItemsCount();
            }).fail(function() {
                dataSource.fireEvent("loadError", arguments);
            });
        },
        allowCollapseAll: function() {
            return false;
        },
        refresh: function(options, isReload, operationTypes) {
            var that = this,
                storeLoadOptions = options.storeLoadOptions,
                dataSource = that._dataSource;

            this.callBase.apply(this, arguments);

            if(isReload || operationTypes.reload) {
                return foreachCollapsedGroups(that, function(groupInfo) {
                    var groupCountQuery = loadTotalCount(dataSource, { filter: createGroupFilter(groupInfo.path, storeLoadOptions) }),
                        groupOffsetQuery = loadTotalCount(dataSource, { filter: createOffsetFilter(groupInfo.path, storeLoadOptions) });

                    return when(groupOffsetQuery, groupCountQuery).done(function(offset, count) {
                        offset = parseInt(offset.length ? offset[0] : offset);
                        count = parseInt(count.length ? count[0] : count);
                        groupInfo.offset = offset;
                        if(groupInfo.count !== count) {
                            groupInfo.count = count;
                            that.updateTotalItemsCount();
                        }
                    });
                }, true);
            }
        }
    };
})());
