import $ from '../../core/renderer';
import domAdapter from '../../core/dom_adapter';
import { getWindow } from '../../core/utils/window';
import eventsEngine from '../../events/core/events_engine';
import { isDefined, isString } from '../../core/utils/type';
import { name as clickEventName } from '../../events/click';
import pointerEvents from '../../events/pointer';
import { addNamespace } from '../../events/utils/index';
import holdEvent from '../../events/hold';
import { when, Deferred } from '../../core/utils/deferred';
import { deferRender } from '../../core/utils/common';

const FOCUS_OVERLAY_CLASS = 'focus-overlay';
const ADD_ROW_BUTTON_CLASS = 'addrow-button';
const DROPDOWN_EDITOR_OVERLAY_CLASS = 'dx-dropdowneditor-overlay';
const EDITOR_CELL_CLASS = 'dx-editor-cell';
const ROW_CLASS = 'dx-row';
const CELL_MODIFIED = 'dx-cell-modified';
const DATA_ROW_CLASS = 'dx-data-row';

const EDIT_MODE_BATCH = 'batch';
const EDIT_MODE_CELL = 'cell';

const TARGET_COMPONENT_NAME = 'targetComponent';

const EDITING_EDITROWKEY_OPTION_NAME = 'editing.editRowKey';
const EDITING_EDITCOLUMNNAME_OPTION_NAME = 'editing.editColumnName';

export default {
    extenders: {
        controllers: {
            editing: {
                init: function() {
                    const needCreateHandlers = !this._saveEditorHandler;

                    this.callBase.apply(this, arguments);

                    if(needCreateHandlers) {
                        // chrome 73+
                        let $pointerDownTarget;
                        let isResizing;
                        this._pointerUpEditorHandler = () => { isResizing = this.getController('columnsResizer')?.isResizing(); };
                        this._pointerDownEditorHandler = e => $pointerDownTarget = $(e.target);
                        this._saveEditorHandler = this.createAction(function(e) {
                            const event = e.event;
                            const $target = $(event.target);
                            const targetComponent = event[TARGET_COMPONENT_NAME];

                            if($pointerDownTarget && $pointerDownTarget.is('input') && !$pointerDownTarget.is($target)) {
                                return;
                            }

                            function checkEditorPopup($element) {
                                return $element && !!$element.closest(`.${DROPDOWN_EDITOR_OVERLAY_CLASS}`).length;
                            }

                            if(this.isCellOrBatchEditMode() && !this._editCellInProgress) {
                                const isEditorPopup = checkEditorPopup($target) || checkEditorPopup(targetComponent?.$element());
                                const isDomElement = !!$target.closest(getWindow().document).length;
                                const isAnotherComponent = targetComponent && !targetComponent._disposed && targetComponent !== this.component;
                                const isAddRowButton = !!$target.closest(`.${this.addWidgetPrefix(ADD_ROW_BUTTON_CLASS)}`).length;
                                const isFocusOverlay = $target.hasClass(this.addWidgetPrefix(FOCUS_OVERLAY_CLASS));
                                const isCellEditMode = this.isCellEditMode();
                                if(!isResizing && !isEditorPopup && !isFocusOverlay && !(isAddRowButton && isCellEditMode && this.isEditing()) && (isDomElement || isAnotherComponent)) {
                                    this._closeEditItem.bind(this)($target);
                                }
                            }
                        });

                        eventsEngine.on(domAdapter.getDocument(), pointerEvents.up, this._pointerUpEditorHandler);
                        eventsEngine.on(domAdapter.getDocument(), pointerEvents.down, this._pointerDownEditorHandler);
                        eventsEngine.on(domAdapter.getDocument(), clickEventName, this._saveEditorHandler);
                    }
                },

                isCellEditMode: function() {
                    return this.option('editing.mode') === EDIT_MODE_CELL;
                },

                isBatchEditMode: function() {
                    return this.option('editing.mode') === EDIT_MODE_BATCH;
                },

                _needToCloseEditableCell: function($targetElement) {
                    const $element = this.component.$element();
                    let result = this.isEditing();
                    const isCurrentComponentElement = !$element || !!$targetElement.closest($element).length;

                    if(isCurrentComponentElement) {
                        const isDataRow = $targetElement.closest('.' + DATA_ROW_CLASS).length;

                        if(isDataRow) {
                            const rowsView = this.getView('rowsView');
                            const $targetCell = $targetElement.closest('.' + ROW_CLASS + '> td');
                            const rowIndex = rowsView.getRowIndex($targetCell.parent());
                            const columnIndex = rowsView.getCellElements(rowIndex).index($targetCell);
                            const visibleColumns = this._columnsController.getVisibleColumns();
                            // TODO jsdmitry: Move this code to _rowClick method of rowsView
                            const allowEditing = visibleColumns[columnIndex] && visibleColumns[columnIndex].allowEditing;

                            result = result && !allowEditing && !this.isEditCell(rowIndex, columnIndex);
                        }

                    }

                    return result || this.callBase.apply(this, arguments);
                },

                _closeEditItem: function($targetElement) {
                    if(this._needToCloseEditableCell($targetElement) && this._checkEditItem($targetElement)) {
                        this.closeEditCell();
                    }
                },

                _focusEditor: function() {
                    if(this.isCellOrBatchEditMode()) {
                        const editColumnIndex = this._getVisibleEditColumnIndex();
                        const $cell = this._rowsView?._getCellElement(this._getVisibleEditRowIndex(), editColumnIndex); // T319885

                        if($cell && !$cell.find(':focus').length) {
                            this._focusEditingCell(() => {
                                this._editCellInProgress = false;
                            }, $cell, true);
                        } else {
                            this._editCellInProgress = false;
                        }
                    }

                    this.callBase.apply(this, arguments);
                },

                isEditing: function() {
                    if(this.isCellOrBatchEditMode()) {
                        const isEditRowKeyDefined = isDefined(this.option(EDITING_EDITROWKEY_OPTION_NAME));
                        const isEditColumnNameDefined = isDefined(this.option(EDITING_EDITCOLUMNNAME_OPTION_NAME));

                        return isEditRowKeyDefined && isEditColumnNameDefined;
                    }

                    return this.callBase.apply(this, arguments);
                },

                _handleEditColumnNameChange: function(args) {
                    const oldRowIndex = this._getVisibleEditRowIndex(args.previousValue);

                    if(this.isCellOrBatchEditMode() && oldRowIndex !== -1 && isDefined(args.value) && args.value !== args.previousValue) {
                        const columnIndex = this._columnsController.getVisibleColumnIndex(args.value);
                        const oldColumnIndex = this._columnsController.getVisibleColumnIndex(args.previousValue);

                        this._editCellFromOptionChanged(columnIndex, oldColumnIndex, oldRowIndex);
                    }
                },

                _addRow: function(parentKey) {
                    const store = this._dataController.store();

                    if(this.isCellEditMode() && store && this.hasChanges()) {
                        const deferred = new Deferred();

                        this.saveEditData().done(() => {
                            // T804894
                            if(!this.hasChanges()) {
                                this.addRow(parentKey).done(deferred.resolve).fail(deferred.reject);
                            } else {
                                deferred.reject('cancel');
                            }
                        });
                        return deferred.promise();
                    }

                    return this.callBase.apply(this, arguments);
                },

                editCell: function(rowIndex, columnIndex) {
                    if(this.isCellOrBatchEditMode()) {
                        if(this._checkFocus(rowIndex, columnIndex)) {
                            return this._editCell({ rowIndex, columnIndex });
                        }

                        return false;
                    }

                    return this.callBase.apply(this, arguments);
                },

                _editCell: function(options) {
                    const d = new Deferred();
                    let coreResult;

                    this.executeOperation(d, () => {
                        coreResult = this._editCellCore(options);
                        when(coreResult)
                            .done(d.resolve)
                            .fail(d.reject);
                    });

                    options.isCellEditing = coreResult !== undefined ? coreResult : d.promise();

                    return this.callBase.apply(this, arguments);
                },

                _editCellCore: function(options) {
                    const dataController = this._dataController;
                    const { columnIndex, rowIndex, column, item } = this._getNormalizedEditCellOptions(options);
                    const params = {
                        data: item?.data,
                        cancel: false,
                        column
                    };

                    if(item.key === undefined) {
                        this._dataController.fireError('E1043');
                        return;
                    }

                    if(column && item && (item.rowType === 'data' || item.rowType === 'detailAdaptive') && !item.removed) {
                        if(this.isEditCell(rowIndex, columnIndex)) {
                            return true;
                        }

                        const editRowIndex = rowIndex + dataController.getRowIndexOffset();

                        return when(this._beforeEditCell(rowIndex, columnIndex, item)).done((cancel) => {
                            if(cancel) {
                                return;
                            }

                            if(!this._prepareEditCell(params, item, columnIndex, editRowIndex)) {
                                this._processCanceledEditingCell();
                            }
                        });
                    }
                    return false;
                },

                _getNormalizedEditCellOptions: function({ oldColumnIndex, oldRowIndex, columnIndex, rowIndex }) {
                    const columnsController = this._columnsController;
                    const visibleColumns = columnsController.getVisibleColumns();
                    const items = this._dataController.items();
                    const item = items[rowIndex];

                    let oldColumn;
                    if(isDefined(oldColumnIndex)) {
                        oldColumn = visibleColumns[oldColumnIndex];
                    } else {
                        oldColumn = this._getEditColumn();
                    }

                    if(!isDefined(oldRowIndex)) {
                        oldRowIndex = this._getVisibleEditRowIndex();
                    }

                    if(isString(columnIndex)) {
                        columnIndex = columnsController.columnOption(columnIndex, 'index');
                        columnIndex = columnsController.getVisibleIndex(columnIndex);
                    }

                    const column = visibleColumns[columnIndex];

                    return { oldColumn, columnIndex, oldRowIndex, rowIndex, column, item };
                },

                _beforeEditCell: function(rowIndex, columnIndex, item) {
                    let d;

                    if(this.isCellEditMode() && !item.isNewRow && this.hasChanges()) {
                        d = new Deferred();
                        this.saveEditData().always(() => {
                            d.resolve(this.hasChanges());
                        });
                    }

                    return this?._validateBeforeEditCell(rowIndex, columnIndex, item, d) || d;
                },

                _prepareEditCell: function(params, item, editColumnIndex, editRowIndex) {
                    if(!item.isNewRow) {
                        params.key = item.key;
                    }

                    if(this._isEditingStart(params)) {
                        return false;
                    }

                    this._pageIndex = this._dataController.pageIndex();

                    this._setEditRowKey(item.key);
                    this._setEditColumnNameByIndex(editColumnIndex);

                    if(!params.column.showEditorAlways) {
                        this._addInternalData({
                            key: item.key,
                            oldData: item.data
                        });
                    }

                    this._afterPrepareEditCell(params);

                    return true;
                },

                closeEditCell: function(isError, withoutSaveEditData) {
                    this.callBase.apply(this, arguments);
                    let result = when();
                    const oldEditRowIndex = this._getVisibleEditRowIndex();

                    if(this.isCellOrBatchEditMode()) {
                        result = Deferred();
                        this.executeOperation(result, () => {
                            this._closeEditCellCore(isError, oldEditRowIndex, withoutSaveEditData);
                            result.resolve();
                        });
                    }

                    this._afterCloseEditCell();

                    return result.promise();
                },

                _closeEditCellCore: function(isError, oldEditRowIndex, withoutSaveEditData) {
                    const dataController = this._dataController;

                    if(this.isCellEditMode() && this.hasChanges()) {
                        if(!withoutSaveEditData) {
                            this.saveEditData().done(error => {
                                if(!this.hasChanges()) {
                                    this.closeEditCell(!!error);
                                }
                            });
                        }
                    } else if(oldEditRowIndex >= 0) {
                        const rowIndices = [oldEditRowIndex];

                        this._resetEditRowKey();
                        this._resetEditColumnName();

                        this._beforeCloseEditCellInBatchMode(rowIndices);
                        if(!isError) {
                            dataController.updateItems({
                                changeType: 'update',
                                rowIndices: rowIndices
                            });
                        }
                    }
                },

                _resetModifiedClassCells: function(changes) {
                    if(this.isBatchEditMode()) {
                        const columnsCount = this._columnsController.getVisibleColumns().length;
                        changes.forEach(({ key }) => {
                            const rowIndex = this._dataController.getRowIndexByKey(key);
                            if(rowIndex !== -1) {
                                for(let columnIndex = 0; columnIndex < columnsCount; columnIndex++) {
                                    this._rowsView._getCellElement(rowIndex, columnIndex).removeClass(CELL_MODIFIED);
                                }
                            }
                        });
                    }
                },

                _prepareChange: function(options, value, text) {
                    const $cellElement = $(options.cellElement);

                    if(this.isBatchEditMode() && options.key !== undefined) {
                        this._applyModified($cellElement, options);
                    }

                    return this.callBase.apply(this, arguments);
                },

                _cancelSaving: function() {
                    const dataController = this._dataController;

                    if(this.isCellOrBatchEditMode()) {
                        if(this.isBatchEditMode()) {
                            this._resetEditIndices();
                        }

                        dataController.updateItems();
                    }

                    this.callBase.apply(this, arguments);
                },

                _editCellFromOptionChanged: function(columnIndex, oldColumnIndex, oldRowIndex) {
                    const columns = this._columnsController.getVisibleColumns();

                    if(columnIndex > -1) {
                        deferRender(() => {
                            this._repaintEditCell(columns[columnIndex], columns[oldColumnIndex], oldRowIndex);
                        });
                    }
                },
            }
        },
        views: {
            rowsView: {
                _createTable: function() {
                    const $table = this.callBase.apply(this, arguments);
                    const editingController = this._editingController;

                    if(editingController.isCellOrBatchEditMode() && this.option('editing.allowUpdating')) {
                        eventsEngine.on($table, addNamespace(holdEvent.name, 'dxDataGridRowsView'), 'td:not(.' + EDITOR_CELL_CLASS + ')', this.createAction(() => {
                            if(editingController.isEditing()) {
                                editingController.closeEditCell();
                            }
                        }));
                    }

                    return $table;
                },
            }
        }
    }
};
