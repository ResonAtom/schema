import { END_OF_STRUCTURE, NIL, INDEX_CHANGE, TYPE_ID } from './spec';
import { Definition, FilterCallback, Client, PrimitiveType, Context } from "./annotations";

import * as encode from "./encoding/encode";
import * as decode from "./encoding/decode";

import { ArraySchema } from "./types/ArraySchema";
import { MapSchema } from "./types/MapSchema";

import { ChangeTree } from "./ChangeTree";

export interface DataChange<T=any> {
    field: string;
    value: T;
    previousValue: T;
}

class EncodeSchemaError extends Error {}

function assertType(value: any, type: string, klass: Schema, field: string) {
    let typeofTarget: string;
    let allowNull: boolean = false;

    switch (type) {
        case "number":
        case "int8":
        case "uint8":
        case "int16":
        case "uint16":
        case "int32":
        case "uint32":
        case "int64":
        case "uint64":
        case "float32":
        case "float64":
            typeofTarget = "number";
            if (isNaN(value)) {
                console.log(`trying to encode "NaN" in ${klass.constructor.name}#${field}`);
            }
            break;
        case "string":
            typeofTarget = "string";
            allowNull = true;
            break;
        case "boolean":
            // boolean is always encoded as true/false based on truthiness
            return;
    }

    if (typeof (value) !== typeofTarget && (!allowNull || (allowNull && value !== null))) {
        let foundValue = `'${JSON.stringify(value)}'${(value && value.constructor && ` (${value.constructor.name})`)}`;
        throw new EncodeSchemaError(`a '${typeofTarget}' was expected, but ${foundValue} was provided in ${klass.constructor.name}#${field}`);
    }
}

function assertInstanceType(value: Schema, type: typeof Schema | typeof ArraySchema | typeof MapSchema, klass: Schema, field: string) {
    if (!(value instanceof type)) {
        throw new EncodeSchemaError(`a '${type.name}' was expected, but '${(value as any).constructor.name}' was provided in ${klass.constructor.name}#${field}`);
    }
}

function encodePrimitiveType (type: PrimitiveType, bytes: number[], value: any, klass: Schema, field: string) {
    assertType(value, type as string, klass, field);

    const encodeFunc = encode[type as string];

    if (encodeFunc) {
        encodeFunc(bytes, value);

    } else {
        throw new EncodeSchemaError(`a '${type}' was expected, but ${value} was provided in ${klass.constructor.name}#${field}`);
    }
}

function decodePrimitiveType (type: string, bytes: number[], it: decode.Iterator) {
    return decode[type as string](bytes, it);
}

/**
 * Schema encoder / decoder
 */
export abstract class Schema {
    static _typeid: number;
    static _context: Context;

    static _schema: Definition;
    static _indexes: {[field: string]: number};
    static _filters: {[field: string]: FilterCallback};
    static _deprecated: {[field: string]: boolean};
    static _descriptors: PropertyDescriptorMap & ThisType<any>;

    static onError(e) {
        console.error(e);
    }

    protected $changes: ChangeTree;

    public onChange?(changes: DataChange[]);
    public onRemove?();

    // allow inherited classes to have a constructor
    constructor(...args: any[]) {
        // fix enumerability of fields for end-user
        Object.defineProperties(this, {
            $changes: { value: new ChangeTree(), enumerable: false, writable: true },
        });

        const descriptors = this._descriptors;
        if (descriptors) {
            Object.defineProperties(this, descriptors);
        }
    }

    get _schema () { return (this.constructor as typeof Schema)._schema; }
    get _descriptors () { return (this.constructor as typeof Schema)._descriptors; }
    get _indexes () { return (this.constructor as typeof Schema)._indexes; }
    get _filters () { return (this.constructor as typeof Schema)._filters; }
    get _deprecated () { return (this.constructor as typeof Schema)._deprecated; }

    get $changed () { return this.$changes.changed; }

    decode(bytes, it: decode.Iterator = { offset: 0 }) {
        const changes: DataChange[] = [];

        const schema = this._schema;
        const indexes = this._indexes;

        const fieldsByIndex = {}
        Object.keys(indexes).forEach((key) => {
            const value = indexes[key];
            fieldsByIndex[value] = key
        })

        const totalBytes = bytes.length;

        // skip TYPE_ID of existing instances
        if (bytes[it.offset] === TYPE_ID) {
            it.offset += 2;
        }

        while (it.offset < totalBytes) {
            const isNil = decode.nilCheck(bytes, it) && ++it.offset;
            const index = bytes[it.offset++];

            if (index === END_OF_STRUCTURE) {
                // reached end of strucutre. skip.
                break;
            }

            const field = fieldsByIndex[index];

            let type = schema[field];
            let value: any;

            let change: any; // for triggering onChange
            let hasChange = false;

            if (!field) {
                continue;

            } else if (isNil) {
                value = null;
                hasChange = true;

            } else if ((type as any)._schema) {
                value = this[`_${field}`] || this.createTypeInstance(bytes, it, type as typeof Schema);
                value.decode(bytes, it);

                hasChange = true;

            } else if (Array.isArray(type)) {
                type = type[0];
                change = [];

                const valueRef: ArraySchema = this[`_${field}`] || new ArraySchema();
                value = valueRef.clone(true);

                const newLength = decode.number(bytes, it);
                const numChanges = Math.min(decode.number(bytes, it), newLength);
                hasChange = (numChanges > 0);

                // FIXME: this may not be reliable. possibly need to encode this variable during serialization
                let hasIndexChange = false;

                // ensure current array has the same length as encoded one
                if (value.length > newLength) {
                    // decrease removed items from number of changes.
                    // no need to iterate through them, as they're going to be removed.

                    Array.prototype.splice.call(value, newLength).forEach((itemRemoved, i) => {
                        if (itemRemoved && itemRemoved.onRemove) {
                            try {
                                itemRemoved.onRemove();
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                        if (valueRef.onRemove) {
                            try {
                                valueRef.onRemove(itemRemoved, newLength + i);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }
                    });
                }

                for (let i = 0; i < numChanges; i++) {
                    const newIndex = decode.number(bytes, it);

                    let indexChangedFrom: number; // index change check
                    if (decode.indexChangeCheck(bytes, it)) {
                        decode.uint8(bytes, it);
                        indexChangedFrom = decode.number(bytes, it);
                        hasIndexChange = true;
                    }

                    let isNew = (!hasIndexChange && value[newIndex] === undefined) || (hasIndexChange && indexChangedFrom === undefined);

                    if ((type as any).prototype instanceof Schema) {
                        let item: Schema;

                        if (isNew) {
                            item = this.createTypeInstance(bytes, it, type as typeof Schema);

                        } else if (indexChangedFrom !== undefined) {
                            item = valueRef[indexChangedFrom];

                        } else {
                            item = valueRef[newIndex]
                        }

                        if (!item) {
                            item = this.createTypeInstance(bytes, it, type as typeof Schema);
                            isNew = true;
                        }

                        item.decode(bytes, it);
                        value[newIndex] = item;

                    } else {
                        value[newIndex] = decodePrimitiveType(type as string, bytes, it);
                    }

                    if (isNew) {
                        if (valueRef.onAdd) {
                            try {
                                valueRef.onAdd(value[newIndex], newIndex);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                    } else if (valueRef.onChange) {
                        try {
                            valueRef.onChange(value[newIndex], newIndex);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }

                    change.push(value[newIndex]);
                }


            } else if ((type as any).map) {
                type = (type as any).map;

                const valueRef: MapSchema = this[`_${field}`] || new MapSchema();
                value = valueRef.clone(true);

                const length = decode.number(bytes, it);
                hasChange = (length > 0);

                // FIXME: this may not be reliable. possibly need to encode this variable during
                // serializagion
                let hasIndexChange = false;

                const previousKeys = Object.keys(valueRef);

                for (let i = 0; i < length; i++) {
                    // `encodeAll` may indicate a higher number of indexes it actually encodes
                    // TODO: do not encode a higher number than actual encoded entries
                    if (
                        bytes[it.offset] === undefined ||
                        bytes[it.offset] === END_OF_STRUCTURE
                    ) {
                        break;
                    }

                    const isNilItem = decode.nilCheck(bytes, it) && ++it.offset;

                    // index change check
                    let previousKey: string;
                    if (decode.indexChangeCheck(bytes, it)) {
                        decode.uint8(bytes, it);
                        previousKey = previousKeys[decode.number(bytes, it)];
                        hasIndexChange = true;
                    }

                    const hasMapIndex = decode.numberCheck(bytes, it);
                    const isSchemaType = typeof(type) !== "string";

                    const newKey = (hasMapIndex)
                        ? previousKeys[decode.number(bytes, it)]
                        : decode.string(bytes, it);

                    let item;
                    let isNew = (!hasIndexChange && valueRef[newKey] === undefined) || (hasIndexChange && previousKey === undefined && hasMapIndex);

                    if (isNew && isSchemaType) {
                        item = this.createTypeInstance(bytes, it, type as typeof Schema);

                    } else if (previousKey !== undefined) {
                        item = valueRef[previousKey];

                    } else {
                        item = valueRef[newKey]
                    }

                    if (isNilItem) {
                        if (item && item.onRemove) {
                            try {
                                item.onRemove();
                            } catch (e) {
                                Schema.onError(e);
                            }

                        }

                        if (valueRef.onRemove) {
                            try {
                                valueRef.onRemove(item, newKey);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                        delete value[newKey];
                        continue;

                    } else if (!isSchemaType) {
                        value[newKey] = decodePrimitiveType(type as string, bytes, it);

                    } else {
                        item.decode(bytes, it);
                        value[newKey] = item;
                    }

                    if (isNew) {
                        if (valueRef.onAdd) {
                            try {
                                valueRef.onAdd(value[newKey], newKey);
                            } catch (e) {
                                Schema.onError(e);
                            }
                        }

                    } else if (valueRef.onChange) {
                        try {
                            valueRef.onChange(value[newKey], newKey);
                        } catch (e) {
                            Schema.onError(e);
                        }
                    }

                }

            } else {
                value = decodePrimitiveType(type as string, bytes, it);
                hasChange = true;
            }

            if (hasChange && this.onChange) {
                changes.push({
                    field,
                    value: change || value,
                    previousValue: this[`_${field}`]
                });
            }

            this[`_${field}`] = value;
        }

        if (this.onChange && changes.length > 0) {
            try {
                this.onChange(changes);
            } catch (e) {
                Schema.onError(e);
            }
        }

        return this;
    }

    encode(root: Schema = this, encodeAll = false, client?: Client) {
        let encodedBytes = [];

        // skip if nothing has changed
        if (!this.$changes.changed && !encodeAll) {
            this._encodeEndOfStructure(this, root, encodedBytes);
            return encodedBytes;
        }

        const schema = this._schema;
        const indexes = this._indexes;
        const filters = this._filters;
        const changes = (encodeAll || client)
            ? this.$changes.allChanges
            : this.$changes.changes;

        for (let i = 0, l = changes.length; i < l; i++) {
            const field = changes[i] as string;

            const type = schema[field];
            const filter = (filters && filters[field]);
            // const value = (filter && this.$allChanges[field]) || changes[field];
            const value = this[`_${field}`];
            const fieldIndex = indexes[field];

            let bytes: number[] = [];

            if (value === undefined) {
                encode.uint8(bytes, NIL);
                encode.number(bytes, fieldIndex);

            } else if ((type as any)._schema) {
                if (client && filter) {
                    // skip if not allowed by custom filter
                    if (!filter.call(this, client, value, root)) {
                        continue;
                    }
                }

                if (!value) {
                    // value has been removed
                    encode.uint8(bytes, NIL);
                    encode.number(bytes, fieldIndex);

                } else {
                    // encode child object
                    encode.number(bytes, fieldIndex);
                    assertInstanceType(value, type as typeof Schema, this, field);

                    this.tryEncodeTypeId(bytes, type as typeof Schema, value.constructor as typeof Schema);

                    bytes.push(...(value as Schema).encode(root, encodeAll, client));
                }

            } else if (Array.isArray(type)) {
                encode.number(bytes, fieldIndex);

                // total of items in the array
                encode.number(bytes, value.length);

                const arrayChanges = (
                    (encodeAll || client)
                        ? value.$changes.allChanges
                        : value.$changes.changes
                    )
                    .filter(index => this[`_${field}`][index] !== undefined)
                    .sort((a, b) => a - b);

                // ensure number of changes doesn't exceed array length
                const numChanges = arrayChanges.length;

                // number of changed items
                encode.number(bytes, numChanges);

                const isChildSchema = typeof(type[0]) !== "string";

                // assert ArraySchema was provided
                assertInstanceType(this[`_${field}`], ArraySchema, this, field);

                // encode Array of type
                for (let j = 0; j < numChanges; j++) {
                    const index = arrayChanges[j];
                    const item = this[`_${field}`][index];

                    if (client && filter) {
                        // skip if not allowed by custom filter
                        if (!filter.call(this, client, item, root)) {
                            continue;
                        }
                    }

                    if (isChildSchema) { // is array of Schema
                        encode.number(bytes, index);

                        if (!encodeAll)  {
                            const indexChange = value.$changes.getIndexChange(item);
                            if (indexChange !== undefined) {
                                encode.uint8(bytes, INDEX_CHANGE);
                                encode.number(bytes, indexChange);
                            }
                        }

                        assertInstanceType(item, type[0] as typeof Schema, this, field);
                        this.tryEncodeTypeId(bytes, type[0] as typeof Schema, item.constructor as typeof Schema);
                        bytes.push(...item.encode(root, encodeAll, client));

                    } else if (item !== undefined) {
                        encode.number(bytes, index);
                        encodePrimitiveType(type[0], bytes, item, this, field);
                    }
                }

                if (!encodeAll) {
                    value.$changes.discard();
                }

            } else if ((type as any).map) {

                // encode Map of type
                encode.number(bytes, fieldIndex);

                // TODO: during `encodeAll`, removed entries are not going to be encoded
                const keys = (encodeAll || client)
                    ? value.$changes.allChanges
                    : value.$changes.changes;

                encode.number(bytes, keys.length)

                // const previousKeys = Object.keys(this[`_${field}`]); // this is costly!
                const previousKeys = value.$changes.allChanges;
                const isChildSchema = typeof((type as any).map) !== "string";
                const numChanges = keys.length;

                // assert MapSchema was provided
                assertInstanceType(this[`_${field}`], MapSchema, this, field);

                for (let i = 0; i < numChanges; i++) {
                    const key = (typeof(keys[i]) === "number" && previousKeys[keys[i]]) || keys[i];
                    const item = this[`_${field}`][key];

                    let mapItemIndex: number = undefined;

                    if (client && filter) {
                        // skip if not allowed by custom filter
                        if (!filter.call(this, client, item, root)) {
                            continue;
                        }
                    }

                    if (encodeAll) {
                        if (item === undefined) {
                            // previously deleted items are skipped during `encodeAll`
                            continue;
                        }

                    } else {
                        // encode index change
                        const indexChange = value.$changes.getIndexChange(item);
                        if (item && indexChange !== undefined) {
                            encode.uint8(bytes, INDEX_CHANGE);
                            encode.number(bytes, this[`_${field}`]._indexes.get(indexChange));
                        }

                        /**
                         * - Allow item replacement
                         * - Allow to use the index of a deleted item to encode as NIL
                         */
                        mapItemIndex = (!value.$changes.isDeleted(key) || !item)
                            ? this[`_${field}`]._indexes.get(key)
                            : undefined;
                    }

                    const isNil = (item === undefined);

                    /**
                     * Invert NIL to prevent collision with data starting with NIL byte
                     */
                    if (isNil) {

                        // TODO: remove item
                        // console.log("REMOVE KEY INDEX", { key });
                        // this[`_${field}`]._indexes.delete(key);
                        encode.uint8(bytes, NIL);
                    }

                    if (mapItemIndex !== undefined) {
                        encode.number(bytes, mapItemIndex);

                    } else {
                        encode.string(bytes, key);
                    }

                    if (item && isChildSchema) {
                        assertInstanceType(item, (type as any).map, this, field);
                        this.tryEncodeTypeId(bytes, (type as any).map, item.constructor as typeof Schema);
                        bytes.push(...item.encode(root, encodeAll, client));

                    } else if (!isNil) {
                        encodePrimitiveType((type as any).map, bytes, item, this, field);
                    }

                }

                if (!encodeAll) {
                    value.$changes.discard();

                    // TODO: track array/map indexes per client (for filtering)?
                    if (!client) {
                        // TODO: do not iterate though all MapSchema indexes here.
                        this[`_${field}`]._updateIndexes(value.$changes.allChanges);
                    }
                }

            } else {
                if (client && filter) {
                    // skip if not allowed by custom filter
                    if (!filter.call(this, client, value, root)) {
                        continue;
                    }
                }

                encode.number(bytes, fieldIndex);
                encodePrimitiveType(type as PrimitiveType, bytes, value, this, field)
            }

            encodedBytes = [...encodedBytes, ...bytes];
        }

        // flag end of Schema object structure
        this._encodeEndOfStructure(this, root, encodedBytes);

        if (!encodeAll && !client) {
            this.$changes.discard();
        }

        return encodedBytes;
    }

    encodeFiltered(client: Client) {
        return this.encode(this, false, client);
    }

    encodeAll () {
        return this.encode(this, true);
    }

    encodeAllFiltered (client: Client) {
        return this.encode(this, true, client);
    }

    clone () {
        const cloned = new ((this as any).constructor);
        const schema = this._schema;
        for (let field in schema) {
            if (
                typeof (this[field]) === "object" &&
                typeof (this[field].clone) === "function"
            ) {
                // deep clone
                cloned[field] = this[field].clone();

            } else {
                // primitive values
                cloned[field] = this[field];
            }
        }
        return cloned;
    }

    triggerAll() {
        if (!this.onChange) {
            return;
        }

        const changes: DataChange[] = [];
        const schema = this._schema;

        for (let field in schema) {
            if (this[field] !== undefined) {
                changes.push({
                    field,
                    value: this[field],
                    previousValue: undefined
                });
            }
        }

        try {
            this.onChange(changes);
        } catch (e) {
            Schema.onError(e);
        }
    }

    toJSON () {
        const schema = this._schema;
        const deprecated = this._deprecated;

        const obj = {}
        for (let field in schema) {
            if (!deprecated[field] && this[field] !== null && typeof (this[field]) !== "undefined") {
                obj[field] = (typeof (this[field].toJSON) === "function")
                    ? this[field].toJSON()
                    : this[`_${field}`];
            }
        }
        return obj;
    }

    private _encodeEndOfStructure(instance: Schema, root: Schema, bytes: number[]) {
        if (instance !== root) {
            bytes.push(END_OF_STRUCTURE);
        }
    }

    private tryEncodeTypeId (bytes: number[], type: typeof Schema, targetType: typeof Schema) {
        if (type._typeid !== targetType._typeid) {
            encode.uint8(bytes, TYPE_ID);
            encode.uint8(bytes, targetType._typeid);
        }
    }

    private createTypeInstance (bytes: number[], it: decode.Iterator, type: typeof Schema): Schema {
        if (bytes[it.offset] === TYPE_ID) {
            it.offset++;
            const anotherType = (this.constructor as typeof Schema)._context.get(decode.uint8(bytes, it));
            return new (anotherType as any)();

        } else {
            return new (type as any)();
        }
    }
}
